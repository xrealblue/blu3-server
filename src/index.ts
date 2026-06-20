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
import { handleWS } from "./ws/handler.js";
import { resolveJioSaavn, resolveJioSaavnById, searchJioSaavnResults } from "./lib/jiosaavnAudio.js";
import { extractAudioUrl, searchYouTube } from "./lib/ytAudio.js";
import { checkRateLimit } from "./lib/ratelimit.js";

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

  const ip = c.req.header("x-forwarded-for") ?? c.req.header("cf-connecting-ip") ?? "unknown";
  const rl = await checkRateLimit(`search:${ip}`, 30);
  if (!rl.success) {
    return c.json({ error: "rate_limited", retryAfter: rl.reset }, 429);
  }

  const results = await searchJioSaavnResults(q);
  return c.json({ tracks: results, source: "jiosaavn" });
});

app.post("/api/resolve", async (c) => {
  const payload = await verifyAuth(c);
  if (!payload) return c.json({ error: "Unauthorized" }, 401);

  let body: { videoId?: string; name?: string; artists?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.videoId?.trim()) return c.json({ error: "Missing videoId" }, 400);

  const ip = c.req.header("x-forwarded-for") ?? c.req.header("cf-connecting-ip") ?? "unknown";
  const rl = await checkRateLimit(`resolve:${ip}`, 60);
  if (!rl.success) {
    return c.json({ error: "rate_limited", retryAfter: rl.reset }, 429);
  }

  const isNumericId = /^\d+$/.test(body.videoId);
  const isYouTubeId = /^[a-zA-Z0-9_-]{11}$/.test(body.videoId);

  let jioResult = null;
  if (isNumericId) {
    jioResult = await resolveJioSaavnById(body.videoId, body.name);
  }

  if (!jioResult && !isYouTubeId && body.name?.trim()) {
    jioResult = await resolveJioSaavn(body.videoId, body.name, body.artists);
  }

  if (jioResult?.url) {
    audioCache.set(body.videoId, { cdnUrl: jioResult.url, fetchedAt: Date.now() });
    return c.json({ source: "youtube", videoId: body.videoId, audioUrl: `/api/audio/${body.videoId}` });
  }

  try {
    const audioUrl = await extractAudioUrl(body.videoId);
    return c.json({
      source: "youtube",
      videoId: body.videoId,
      audioUrl: `/api/yt-audio/${body.videoId}`,
    });
  } catch (err) {
    console.error(`[Resolve] yt-dlp fallback failed for ${body.videoId}:`, err);
  }

  if (body.name?.trim()) {
    try {
      const searchQuery = `${body.name} ${body.artists ?? ""}`.trim();
      const foundId = await searchYouTube(searchQuery);
      if (foundId) {
        const audioUrl = await extractAudioUrl(foundId);
        return c.json({
          source: "youtube",
          videoId: foundId,
          audioUrl: `/api/yt-audio/${foundId}`,
        });
      }
    } catch (err) {
      console.error(`[Resolve] YouTube search fallback failed:`, err);
    }
  }

  return c.json({ source: "youtube", videoId: body.videoId });
});

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

  const cached = audioCache.get(videoId);
  if (!cached || Date.now() - cached.fetchedAt > CACHE_TTL) {
    audioCache.delete(videoId);
    return c.json({ error: "Audio not found or expired" }, 404);
  }

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

    return c.newResponse(cdnRes.body as any, cdnRes.status as any, responseHeaders);
  } catch (err) {
    console.error(`[AudioProxy] error for ${videoId}:`, err);
    audioCache.delete(videoId);
    return c.json({ error: "Proxy failed" }, 404);
  }
});

const port = Number(process.env.PORT ?? 8000);

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
