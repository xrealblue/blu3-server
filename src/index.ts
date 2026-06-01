import { serve, upgradeWebSocket } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import * as dotenv from "dotenv";
dotenv.config();
import { WebSocketServer } from "ws";
import https from "node:https";
import { Readable } from "node:stream";
import authRoute from "./routes/auth.js";
import roomsRoute from "./routes/rooms.js";
import playlistsRoute from "./routes/playlists.js";
import { handleWS } from "./ws/handler.js";
import { getYTMusic, resetYTMusic } from "./lib/ytmusic.js";
import { encrypt } from "./lib/crypto.js";
import { getAudioStreamUrl, getCookieStatus, testExtract, invalidateCache } from "./lib/stream.js";

const _ipv4Agent = new https.Agent({ family: 4, keepAlive: true });

async function ipv4Fetch(url: string, init?: { headers?: Record<string, string> }): Promise<Response> {
  const maxRedirects = 5;
  const { headers } = init || {};
  const followRedirect = async (target: string, depth: number): Promise<Response> => {
    if (depth > maxRedirects) throw new Error("Too many redirects");
    return new Promise((resolve, reject) => {
      const req = https.get(target, { agent: _ipv4Agent, headers }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, target).toString();
          return resolve(followRedirect(redirectUrl, depth + 1));
        }
        const responseHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v) responseHeaders.set(k, Array.isArray(v) ? v.join(", ") : v);
        }
        const webStream = Readable.toWeb(res) as ReadableStream<Uint8Array>;
        resolve(new Response(webStream, {
          status: res.statusCode,
          headers: responseHeaders,
        }));
      });
      req.on("error", reject);
    });
  };
  return followRedirect(url, 0);
}

const getCorsOrigins = (): string[] => {
  const defaultOrigins = ["http://localhost:3000", "https://blu3.in"];
  const originsEnv = process.env.CORS_ORIGINS;
  if (!originsEnv) {
    return defaultOrigins;
  }
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
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS", "PUT"], // Added PUT/PATCH if needed
    allowHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  }),
);

app.get("/", (c) => c.json({ status: "ok", service: "blu3-api" }));
app.get("/health", (c) => c.json({ status: "ok" }));
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

app.get("/api/search", async (c) => {
  const q = c.req.query("q");
  if (!q?.trim()) return c.json({ tracks: [] });
  try {
    const yt = await getYTMusic();
    const results = await yt.searchSongs(q);
    const tracks = results
      .filter((r) => r.videoId)
      .map((r) => {
        const thumbs = r.thumbnails ?? [];
        const rawThumb = thumbs[thumbs.length - 1]?.url ?? "";
        const image = rawThumb.replace(/=w\d+-h\d+.*$/, "=w226-h226-l90-rj");
        const encryptedId = encrypt(r.videoId);
        return {
          id: r.videoId,
          videoId: r.videoId,
          name: r.name,
          duration_ms: (r.duration ?? 0) * 1000,
          explicit: false,
          artists: r.artist ? [{ name: r.artist.name }] : [],
          album: { name: r.album?.name ?? "" },
          image,
          downloadUrl: encryptedId,
        };
      });
    return c.json({ tracks });
  } catch (err) {
    console.error("Search error:", err);
    resetYTMusic();
    return c.json({ error: "Search failed" }, 500);
  }
});

app.get("/debug/stream", async (c) => {
  const videoId = c.req.query("v");
  if (!videoId) return c.json({ error: "?v=VIDEO_ID required" }, 400);
  const result = await testExtract(videoId);
  return c.json(result);
});

app.get("/stream/:id", async (c) => {
  const videoId = c.req.param("id");
  if (!videoId) return c.json({ error: "Missing video id" }, 400);

  let streamUrl: string | null = null;
  try {
    streamUrl = await getAudioStreamUrl(videoId);
  } catch (err) {
    console.error("Stream error:", err);
    return c.json({ error: "Failed to get stream" }, 500);
  }

  if (!streamUrl) {
    return c.json({ error: "Stream not found" }, 404);
  }

  const invalidate = c.req.query("invalidate");
  if (invalidate) {
    invalidateCache(videoId).catch(() => {});
  }

  try {
    const range = c.req.header("range");
    const upstreamHeaders: Record<string, string> = {};
    if (range) upstreamHeaders["Range"] = range;

    let upstream = await ipv4Fetch(streamUrl, {
      headers: upstreamHeaders,
    });

    if (!upstream.ok && upstream.status !== 206) {
      invalidateCache(videoId).catch(() => {});
      streamUrl = await getAudioStreamUrl(videoId);
      if (streamUrl) {
        upstream = await ipv4Fetch(streamUrl, { headers: upstreamHeaders });
      }
    }

    if (!upstream.ok && upstream.status !== 206) {
      return c.json({ error: "Stream unavailable" }, 502);
    }

    const proxyHeaders = new Headers(upstream.headers);
    proxyHeaders.set("Access-Control-Allow-Origin", "*");
    proxyHeaders.set("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length, Content-Type");

    return new Response(upstream.body, {
      status: upstream.status,
      headers: proxyHeaders,
    });
  } catch (err) {
    console.error("Stream proxy error:", err);
    return c.json({ error: "Stream proxy failed" }, 502);
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
    const suggestions: string[] = (parsed[1] ?? []).map((s: unknown[]) =>
      String(s[0]),
    );
    return c.json({ suggestions: suggestions.slice(0, 8) });
  } catch {
    return c.json({ suggestions: [] });
  }
});

const port = Number(process.env.PORT ?? 8000);

// ← KEY: create wss with noServer:true, pass via websocket option
const wss = new WebSocketServer({ noServer: true });

serve(
  {
    fetch: app.fetch,
    port,
    websocket: { server: wss }, // ← attach here
  },
  (info) => {
    console.log(`blu3 API running on http://localhost:${info.port}`);
  },
);
