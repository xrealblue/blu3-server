import "./lib/env.js";

import { serve, upgradeWebSocket } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { getCookie } from "hono/cookie";
import { WebSocketServer } from "ws";
import { auth, getSessionFromRequest } from "./lib/auth.js";
import { db } from "./db/index.js";
import * as schema from "./db/schema.js";
import { eq } from "drizzle-orm";
import roomsRoute from "./routes/rooms.js";
import playlistsRoute from "./routes/playlists.js";
import audioFallbackRoute from "./routes/audioFallback.js";
import { handleWS, flushAllPendingSyncs } from "./ws/handler.js";
import { startCronJobs } from "./cron.js";
import { resolveJioSaavn, resolveJioSaavnById, searchJioSaavnResults } from "./lib/jiosaavnAudio.js";
import { searchYouTube, searchYouTubeResults, getYoutubeMusicAlbumArt, getYouTubeVideoInfo, searchYouTubeWithMetadata, getYouTubeAudioUrl } from "./lib/ytAudio.js";
import { checkRateLimit } from "./lib/ratelimit.js";
import { httpRequestDuration, httpRequestTotal, metricsHandler, getMetricsContentType } from "./lib/metrics.js";


const audioCache = new Map<string, { cdnUrl: string; fetchedAt: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000;

setInterval(() => {
  const cutoff = Date.now() - CACHE_TTL;
  for (const [key, entry] of audioCache) {
    if (entry.fetchedAt < cutoff) audioCache.delete(key);
  }
}, 5 * 60 * 1000);

async function verifyAuth(c: any) {
  const session = await getSessionFromRequest(c.req.raw.headers);
  return session?.user || null;
}

const getCorsOrigins = (): string[] => {
  const defaultOrigins = ["http://localhost:3000", "https://blu3.in"];
  const originsEnv = process.env.CORS_ORIGINS;
  if (!originsEnv) return defaultOrigins;
  const parsed = originsEnv
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  return [...new Set([...defaultOrigins, ...parsed])];
};

const app = new Hono();

const corsOrigins = getCorsOrigins();

app.use("*", async (c, next) => {
  const url = c.req.url;
  const masked = url.includes("/ws?") ? url.replace(/token=[^&]+/, "token=***") : url;
  const method = c.req.method;
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  const status = c.res.status;
  console.log(`${method} ${masked} ${status} ${ms}ms`);
  try {
    const path = new URL(url).pathname;
    httpRequestDuration.observe({ method, path, status }, ms);
    httpRequestTotal.inc({ method, path, status });
  } catch {}
});

app.use("*", async (c, next) => {
  const origin = c.req.header("origin") || "";
  const isAllowed = corsOrigins.includes(origin);

  if (c.req.method === "OPTIONS") {
    if (isAllowed) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Credentials", "true");
      c.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS, PUT");
      c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }
    c.header("Vary", "Origin");
    return c.body(null, 204);
  }

  await next();

  if (isAllowed) {
    c.res.headers.set("Access-Control-Allow-Origin", origin);
    c.res.headers.set("Access-Control-Allow-Credentials", "true");
  }
  c.res.headers.set("Vary", "Origin");
});

const RATE_LIMIT_CONFIGS: Record<string, { max: number; windowMs: number }> = {
  "/api/search": { max: 30, windowMs: 60_000 },
  "/api/resolve": { max: 60, windowMs: 60_000 },
  "/api/resolve-link": { max: 20, windowMs: 60_000 },
  "/api/playlists": { max: 40, windowMs: 60_000 },
  "/api/rooms": { max: 20, windowMs: 60_000 },
  "/api/auth": { max: 10, windowMs: 60_000 },
  "/api/audio/": { max: 200, windowMs: 60_000 },
};

app.use("*", async (c, next) => {
  if (c.req.method === "OPTIONS") return next();
  const path = c.req.path;
  const matched = Object.entries(RATE_LIMIT_CONFIGS).find(([prefix]) => path.startsWith(prefix));
  if (!matched) return next();
  const [, { max, windowMs }] = matched;
  const identifier = c.req.header("x-forwarded-for") ?? c.req.header("cf-connecting-ip") ?? c.req.header("x-real-ip") ?? "unknown";
  const rl = await checkRateLimit(`http:${path}:${identifier}`, max, windowMs);
  if (!rl.success) {
    return c.json({ error: "rate_limited", retryAfter: rl.reset }, 429);
  }
  return next();
});

app.get("/", (c) => {
  const error = c.req.query("error");
  if (error) {
    const frontendUrl = (process.env.FRONTEND_URL?.split(",")[0]?.trim()) || "https://blu3.in";
    return c.redirect(`${frontendUrl}/?error=${encodeURIComponent(error)}`);
  }
  return c.json({ status: "ok", service: "blu3-api" });
});
app.get("/healthz", (c) => c.json({ status: "ok" }));
app.get("/readyz", async (c) => {
  const issues: string[] = [];
  try {
    await db.execute("SELECT 1");
  } catch {
    issues.push("db");
  }
  try {
    const { getRedis } = await import("./lib/redis.js");
    const r = getRedis();
    if (r) await r.ping();
  } catch {
    issues.push("redis");
  }
  if (issues.length > 0) return c.json({ status: "degraded", issues }, 503);
  return c.json({ status: "ok" });
});
app.get("/metrics", async (c) => {
  const body = await metricsHandler();
  c.header("Content-Type", getMetricsContentType());
  return c.body(body);
});

// ─── Desktop OAuth Redirect ─────────────────────────────────────────────────
// After Google/Discord auth completes, better-auth sets a session cookie and
// redirects here. We read the session token from the cookie and redirect to
// the blu3:// custom protocol so the Electron app can pick up the session.
app.get("/api/auth/desktop-redirect", async (c) => {
  const sessionToken =
    getCookie(c, "better-auth.session_token") ||
    getCookie(c, "__Secure-better-auth.session_token") ||
    "";

  if (sessionToken) {
    return c.redirect(`blu3://auth-callback?token=${encodeURIComponent(sessionToken)}`);
  }

  const frontendUrl = (process.env.FRONTEND_URL?.split(",")[0]?.trim()) || "https://blu3.in";
  return c.redirect(`${frontendUrl}/?error=auth_failed`);
});

app.on(["GET", "POST"], "/api/auth/*", async (c) => {
  const res = await auth.handler(c.req.raw);
  const origin = c.req.header("origin");
  if (origin && getCorsOrigins().includes(origin)) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.set("Access-Control-Allow-Credentials", "true");
  }
  return res;
});

app.route("/api/rooms", roomsRoute);
app.route("/api/playlists", playlistsRoute);
app.route("/api", audioFallbackRoute);

app.get(
  "/ws",
  upgradeWebSocket((c) => {
    let handlers: Awaited<ReturnType<typeof handleWS>> = null;
    return {
      async onOpen(_, ws) {
        const url = new URL(c.req.url);
        handlers = await handleWS(ws, url);
      },
      onMessage(event) {
        handlers?.onMessage(event);
      },
      onClose() {
        handlers?.onClose();
      },
      onError(err) {
        console.error("WS error:", err);
      },
    };
  }),
);

app.get("/api/search", async (c) => {
  const q = c.req.query("q");
  if (!q?.trim()) return c.json({ tracks: [] });

  // const tracks = await searchJioSaavnResults(q);
  const ytResults = await searchYouTubeResults(q);
  const tracks = ytResults.map((r) => ({
    id: r.videoId,
    videoId: r.videoId,
    name: r.name,
    duration_ms: r.durationMs,
    artists: [{ name: r.artist || "Unknown" }],
    album: { name: "" },
    image: r.thumbnail,
    source: "youtube" as const,
  }));
  return c.json({ tracks });
});

app.post("/api/resolve", async (c) => {
  const payload = await verifyAuth(c);
  if (!payload) return c.json({ error: "Unauthorized" }, 401);

  let body: { videoId?: string; name?: string; artists?: string; duration?: number; source?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.videoId?.trim()) return c.json({ error: "Missing videoId" }, 400);

  const isNumericId = /^\d+$/.test(body.videoId);
  const isYouTubeId = /^[a-zA-Z0-9_-]{11}$/.test(body.videoId);
  const preferYoutube = body.source === "youtube";

  function cacheAndReturn(cdnUrl: string, resolvedSource: string) {
    audioCache.set(body.videoId!, { cdnUrl, fetchedAt: Date.now() });
    return c.json({ source: resolvedSource, videoId: body.videoId, audioUrl: `/api/audio/${body.videoId}` });
  }

  let jioResult: { url: string; source: string; videoId: string } | null = null;

  if (!preferYoutube) {
    if (isNumericId) {
      jioResult = await resolveJioSaavnById(body.videoId, body.name);
    }

    if (!jioResult && body.name?.trim()) {
      jioResult = await resolveJioSaavn(body.videoId, body.name, body.artists, body.duration);
    }

    if (jioResult?.url) {
      return cacheAndReturn(jioResult.url, "jiosaavn");
    }
  }

  if (isYouTubeId) {
    const ytAudioUrl = await getYouTubeAudioUrl(body.videoId, AbortSignal.timeout(6000));
    if (ytAudioUrl) {
      return cacheAndReturn(ytAudioUrl, "youtube");
    }
  }

  if (body.name?.trim()) {
    const yt = await searchYouTubeWithMetadata(`${body.name} ${body.artists || ""}`.trim());
    if (yt?.videoId) {
      return c.json({ source: "youtube", videoId: yt.videoId, image: yt.thumbnail });
    }
  }

  const albumArt = body.name ? await getYoutubeMusicAlbumArt(body.name, body.artists) : undefined;
  return c.json({ source: "youtube", videoId: body.videoId, ...(albumArt ? { image: albumArt } : {}) });
});

function extractYouTubeId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

app.post("/api/resolve-link", async (c) => {
  const payload = await verifyAuth(c);
  if (!payload) return c.json({ error: "Unauthorized" }, 401);

  const { url } = await c.req.json();
  if (!url?.trim()) return c.json({ error: "Missing url" }, 400);

  const preResolveAudio = (vid: string) => {
    getYouTubeAudioUrl(vid, AbortSignal.timeout(8000))
      .then((ytUrl) => { if (ytUrl) audioCache.set(vid, { cdnUrl: ytUrl, fetchedAt: Date.now() }); })
      .catch(() => {});
  };

  let videoId = extractYouTubeId(url.trim());
  if (videoId) {
    preResolveAudio(videoId);
    const info = await getYouTubeVideoInfo(videoId);
    if (info) {
      return c.json({ videoId, name: info.title, artist: info.artist, image: info.thumbnail, source: "youtube" });
    }
    // getYouTubeVideoInfo failed — YouTube may have redirected the videoId in a mix/radio context.
    // Fall back to the oEmbed API which always returns correct metadata for any valid video URL.
    try {
      const oembedRes = await fetch(
        `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
        { signal: AbortSignal.timeout(3000) },
      );
      if (oembedRes.ok) {
        const oembed: any = await oembedRes.json();
        return c.json({
          videoId,
          name: oembed.title || "",
          artist: oembed.author_name || "",
          image: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
          source: "youtube",
        });
      }
    } catch {}
    return c.json({ videoId, name: "", artist: "", image: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, source: "youtube" });
  }

  const spotifyMatch = url.match(/open\.spotify\.com\/track\/([a-zA-Z0-9]+)/);
  if (spotifyMatch) {
    try {
      const oembedRes = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url.trim())}`, { signal: AbortSignal.timeout(5000) });
      if (oembedRes.ok) {
        const oembed = await oembedRes.json() as any;
        const trackName: string = oembed.title || "";
        const thumb: string = oembed.thumbnail_url || "";
        let spotifyArtist = "";

        try {
          const pageRes = await fetch(url.trim(), { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(4000) });
          if (pageRes.ok) {
            const html = await pageRes.text();
            const titleMatch = html.match(/<title>(.+?)<\/title>/i);
            if (titleMatch) {
              const parts = titleMatch[1].split(" · ").map((s: string) => s.trim());
              if (parts.length >= 3) spotifyArtist = parts[1];
            }
          }
        } catch {}

        const nameLower = trackName.toLowerCase();
        const artistLower = spotifyArtist.toLowerCase();
        const queries = spotifyArtist ? [`${trackName} ${spotifyArtist}`, trackName] : [trackName];
        for (const q of [...new Set(queries)]) {
          const results = await searchYouTubeResults(q);
          const match = results.find((r) => {
            if (!r.videoId) return false;
            if (!r.name) return false;
            const rn = r.name.toLowerCase();
            if (!rn.includes(nameLower) && !nameLower.includes(rn)) return false;
            if (artistLower && r.artist) {
              const ra = r.artist.toLowerCase();
              const spotifyArtists = artistLower.split(/[,&]+\s*/).map((s: string) => s.trim());
              const matchesArtist = spotifyArtists.some((a) => ra.includes(a) || a.includes(ra));
              if (!matchesArtist) return false;
            }
            return true;
          });
          if (match) {
            preResolveAudio(match.videoId);
            return c.json({ videoId: match.videoId, name: trackName, artist: spotifyArtist || match.artist, image: thumb || match.thumbnail, source: "youtube" });
          }
        }

        const fb = await searchYouTubeResults(trackName);
        const first = fb?.[0];
        if (first?.videoId) {
          preResolveAudio(first.videoId);
          return c.json({ videoId: first.videoId, name: trackName, artist: spotifyArtist || first.artist, image: thumb || first.thumbnail, source: "youtube" });
        }
      }
    } catch {}
  }

  const appleMatch = url.match(/music\.apple\.com\/([a-z]{2}\/)?.+?\/(.+?)\/(.+?)\/(\d+)/);
  if (appleMatch) {
    const query = url.split("/").filter((s: string) => s && !(/^[a-z]{2}$/).test(s)).slice(-3).join(" ").replace(/-/g, " ");
    const yt = await searchYouTubeWithMetadata(query);
    if (yt) {
      preResolveAudio(yt.videoId);
      return c.json({ videoId: yt.videoId, name: yt.videoId, artist: "", image: yt.thumbnail, source: "youtube" });
    }
  }

  const yt = await searchYouTubeWithMetadata(url.trim());
  if (yt) {
    preResolveAudio(yt.videoId);
    return c.json({ videoId: yt.videoId, name: url.trim(), artist: "", image: yt.thumbnail, source: "youtube" });
  }

  return c.json({ error: "Could not resolve link" }, 400);
});

async function resolveAudioUrl(videoId: string): Promise<string | null> {
  const isNumericId = /^\d+$/.test(videoId);
  if (isNumericId) {
    const jioResult = await resolveJioSaavnById(videoId, undefined);
    if (jioResult?.url) return jioResult.url;
  }
  if (/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    const ytAudioUrl = await getYouTubeAudioUrl(videoId, AbortSignal.timeout(6000));
    if (ytAudioUrl) return ytAudioUrl;
  }
  return null;
}

app.get("/api/audio/:videoId", async (c) => {
  let session = await getSessionFromRequest(c.req.raw.headers);
  if (!session) {
    const token = c.req.query("token");
    if (token) {
      const [s] = await db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.token, token))
        .limit(1);
      if (s && s.expiresAt > new Date()) {
        const [user] = await db
          .select()
          .from(schema.users)
          .where(eq(schema.users.id, s.userId))
          .limit(1);
        if (user) session = { user, session: s };
      }
    }
  }
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const videoId = c.req.param("videoId");
  if (!videoId?.trim()) return c.json({ error: "Missing videoId" }, 400);

  let cached = audioCache.get(videoId);
  if (!cached || Date.now() - cached.fetchedAt > CACHE_TTL) {
    audioCache.delete(videoId);
    const resolvedUrl = await resolveAudioUrl(videoId);
    if (resolvedUrl) {
      cached = { cdnUrl: resolvedUrl, fetchedAt: Date.now() };
      audioCache.set(videoId, cached);
    }
  }
  if (!cached) return c.json({ error: "Audio not found or expired" }, 404);

  try {
    const cdnRes = await fetch(cached.cdnUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://www.jiosaavn.com/",
        "Range": c.req.header("Range") ?? "",
      },
    });
    if (!cdnRes.ok && cdnRes.status !== 206) {
      audioCache.delete(videoId);
      return c.json({ error: "Source unavailable" }, 404);
    }

    const responseHeaders: Record<string, string> = {};
    cdnRes.headers.forEach((value, key) => {
      if (["content-type", "content-length", "content-range", "accept-ranges"].includes(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    });
    responseHeaders["Cache-Control"] = "private, max-age=3600";
    responseHeaders["X-Content-Type-Options"] = "nosniff";
    const origin = c.req.header("origin");
    if (origin && corsOrigins.includes(origin)) {
      responseHeaders["Access-Control-Allow-Origin"] = origin;
      responseHeaders["Access-Control-Allow-Credentials"] = "true";
    }

    return c.newResponse(cdnRes.body as any, cdnRes.status as any, responseHeaders);
  } catch (err) {
    console.error(`[AudioProxy] error for ${videoId}:`, err);
    audioCache.delete(videoId);
    return c.json({ error: "Proxy failed" }, 404);
  }
});

const port = Number(process.env.PORT ?? 8000);

startCronJobs();

const wss = new WebSocketServer({ noServer: true });

serve(
  {
    fetch: app.fetch,
    port,
    websocket: { server: wss },
  },
  (info) => {
    console.log(`blu3 API running on http://localhost:${info.port}`);
    console.log(`Health: http://localhost:${info.port}/healthz`);
    console.log(`Ready:  http://localhost:${info.port}/readyz`);
  },
);

process.on("SIGTERM", async () => {
  console.log("SIGTERM received, flushing pending syncs...");
  await flushAllPendingSyncs();
  process.exit(0);
});
