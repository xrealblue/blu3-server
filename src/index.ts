import { serve, upgradeWebSocket } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { verify } from "hono/jwt";
import * as dotenv from "dotenv";
import { existsSync } from "fs";
dotenv.config();
if (existsSync(".env.private")) dotenv.config({ path: ".env.private" });
import { WebSocketServer } from "ws";
import authRoute from "./routes/auth.js";
import roomsRoute from "./routes/rooms.js";
import playlistsRoute from "./routes/playlists.js";
import { handleWS } from "./ws/handler.js";
import { YtMusicSearchProvider } from "./lib/searchProvider.js";
import { YtDlpResolver } from "./lib/audioResolver.js";
import { resolveJioSaavn } from "./lib/jiosaavnAudio.js";
import { checkRateLimit } from "./lib/ratelimit.js";

const audioCache = new Map<string, { cdnUrl: string; fetchedAt: number }>();

async function verifyAuth(c: any) {
  const auth = c.req.header("Authorization");
  if (!auth?.startsWith("Bearer ")) return null;
  try {
    return await verify(auth.slice(7), process.env.JWT_SECRET!, "HS256");
  } catch {
    return null;
  }
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

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: getCorsOrigins(),
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS", "PUT"],
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

app.get("/", (c) => c.json({ status: "ok", service: "blu3-api" }));
app.get("/healthz", (c) => c.json({ status: "ok" }));
app.get("/readyz", async (c) => {
  const issues: string[] = [];
  try {
    const { db } = await import("./db/index.js");
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

app.route("/auth", authRoute);
app.route("/api/rooms", roomsRoute);
app.route("/api/playlists", playlistsRoute);

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

const searchProvider = new YtMusicSearchProvider();
const audioResolver = new YtDlpResolver();

app.get("/api/search", async (c) => {
  const q = c.req.query("q");
  if (!q?.trim()) return c.json({ tracks: [] });

  const ip = c.req.header("x-forwarded-for") ?? c.req.header("cf-connecting-ip") ?? "unknown";
  const rl = await checkRateLimit(`search:${ip}`, 30);
  if (!rl.success) {
    return c.json({ error: "rate_limited", retryAfter: rl.reset }, 429);
  }

  try {
    const result = await searchProvider.search(q);
    return c.json(result);
  } catch (err) {
    console.error("Search error:", err);
    return c.json({ error: "Search failed" }, 500);
  }
});

app.get("/api/resolve/:videoId", async (c) => {
  const videoId = c.req.param("videoId");
  if (!videoId?.trim()) return c.json({ error: "Missing videoId" }, 400);

  const ip = c.req.header("x-forwarded-for") ?? c.req.header("cf-connecting-ip") ?? "unknown";
  const rl = await checkRateLimit(`resolve:${ip}`, 60);
  if (!rl.success) {
    return c.json({ error: "rate_limited", retryAfter: rl.reset }, 429);
  }

  try {
    const result = await audioResolver.resolve(videoId);
    if (!result) return c.json({ error: "Failed to resolve audio" }, 502);
    return c.json(result);
  } catch (err) {
    console.error(`[Resolve] error for ${videoId}:`, err);
    return c.json({ error: "Resolution failed" }, 500);
  }
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

  if (body.name?.trim()) {
    const jioResult = await resolveJioSaavn(body.videoId, body.name, body.artists);
    if (jioResult?.url) {
      audioCache.set(body.videoId, { cdnUrl: jioResult.url, fetchedAt: Date.now() });
      return c.json({ source: "youtube", videoId: body.videoId, audioUrl: `/api/audio/${body.videoId}` });
    }
  }

  try {
    const result = await audioResolver.resolve(body.videoId);
    if (!result) return c.json({ error: "Failed to resolve audio" }, 502);
    if (result.url) {
      audioCache.set(body.videoId, { cdnUrl: result.url, fetchedAt: Date.now() });
    }
    return c.json({ ...result, source: "youtube" });
  } catch (err) {
    console.error(`[Resolve] error for ${body.videoId}:`, err);
    return c.json({ error: "Resolution failed" }, 500);
  }
});

app.get("/api/audio/:videoId", async (c) => {
  const token = c.req.query("token") ?? c.req.header("Authorization")?.slice(7);
  if (!token) return c.json({ error: "Unauthorized" }, 401);
  try {
    await verify(token, process.env.JWT_SECRET!, "HS256");
  } catch {
    return c.json({ error: "Invalid token" }, 401);
  }

  const videoId = c.req.param("videoId");
  if (!videoId?.trim()) return c.json({ error: "Missing videoId" }, 400);

  const cached = audioCache.get(videoId);
  if (!cached) return c.json({ error: "Audio not found" }, 404);

  const maxAge = 1800000;
  if (Date.now() - cached.fetchedAt > maxAge) {
    audioCache.delete(videoId);
    return c.json({ error: "Audio expired" }, 404);
  }

  try {
    const cdnRes = await fetch(cached.cdnUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Range": c.req.header("Range") ?? "",
      },
    });
    if (!cdnRes.ok && cdnRes.status !== 206) {
      audioCache.delete(videoId);
      return c.json({ error: "Source unavailable" }, 502);
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
    return c.json({ error: "Proxy failed" }, 502);
  }
});

app.get("/api/suggest", async (c) => {
  const q = c.req.query("q");
  if (!q?.trim()) return c.json({ suggestions: [] });
  try {
    const res = await fetch(
      `https://suggestqueries-clients6.youtube.com/complete/search?client=youtube&ds=yt&q=${encodeURIComponent(q)}`,
    );
    const text = await res.text();
    const match = text.match(/\[.*\]/s);
    if (!match) return c.json({ suggestions: [] });
    const parsed = JSON.parse(match[0]);
    const suggestions: string[] = (parsed[1] ?? []).map((s: unknown[]) => String(s[0]));
    return c.json({ suggestions: suggestions.slice(0, 8) });
  } catch {
    return c.json({ suggestions: [] });
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
