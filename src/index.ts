import { serve, upgradeWebSocket } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import * as dotenv from "dotenv";
dotenv.config();
import { WebSocketServer } from "ws";
import authRoute from "./routes/auth.js";
import roomsRoute from "./routes/rooms.js";
import playlistsRoute from "./routes/playlists.js";
import { handleWS } from "./ws/handler.js";
import { getYTMusic, resetYTMusic, searchSongsWithRealVideoIds } from "./lib/ytmusic.js";
import { getCookieStatus, getAudioStreamUrl } from "./lib/stream.js";

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
    const results = await searchSongsWithRealVideoIds(q);

    const tracks = results.map((r) => {
      const thumbs = r.thumbnails ?? [];
      const thumb = thumbs[thumbs.length - 1]?.url ?? "";
      const image = thumb.replace(/=w\d+-h\d+.*$/, "=w226-h226-l90-rj");
      return {
        id: r.videoId,
        videoId: r.videoId,
        name: r.name,
        duration_ms: (r.duration ?? 0) * 1000,
        explicit: false,
        artists: r.artist ? [{ name: r.artist.name }] : [],
        album: { name: r.album?.name ?? "" },
        image,
      };
    });

    return c.json({ tracks });
  } catch (err) {
    console.error("Search error:", err);
    resetYTMusic();
    return c.json({ error: "Search failed" }, 500);
  }
});

app.get("/stream/:id", async (c) => {
  const videoId = c.req.param("id");
  if (!videoId?.trim()) return c.json({ error: "Missing videoId" }, 400);

  const result = await getAudioStreamUrl(videoId);
  if (!result) return c.json({ error: "Stream not available" }, 404);

  const range = c.req.header("Range");
  const upstreamHeaders: Record<string, string> = {};
  if (range) upstreamHeaders["Range"] = range;

  try {
    const upstream = await fetch(result.url, {
      headers: upstreamHeaders,
      redirect: "follow",
    });
    if (!upstream.ok && upstream.status !== 206) {
      return c.json({ error: "Stream unavailable" }, 502);
    }

    const proxyHeaders = new Headers(upstream.headers);
    proxyHeaders.set("Access-Control-Allow-Origin", "*");
    proxyHeaders.set(
      "Access-Control-Expose-Headers",
      "Content-Range, Accept-Ranges, Content-Length, Content-Type"
    );

    return new Response(upstream.body, {
      status: upstream.status,
      headers: proxyHeaders,
    });
  } catch (err) {
    console.error("Stream proxy error:", err);
    return c.json({ error: "Stream proxy failed" }, 502);
  }
});

app.get("/stream-url/:id", async (c) => {
  const videoId = c.req.param("id");
  if (!videoId?.trim()) return c.json({ error: "Missing videoId" }, 400);

  const result = await getAudioStreamUrl(videoId);
  if (!result) return c.json({ error: "Stream not available" }, 404);

  return c.json({ url: result.url, mimeType: result.mimeType });
});

app.get("/debug", async (c) => {
  return c.json({
    status: "ok",
    uptime: process.uptime(),
    stream: getCookieStatus(),
  });
});

app.get("/debug/test/:id", async (c) => {
  const videoId = c.req.param("id");
  const cookieStatus = getCookieStatus();

  const CLIENTS = ["TV_EMBEDDED", "ANDROID", "TV", "ANDROID_VR", "TV_SIMPLY", "WEB"] as const;
  const results: Record<string, any> = {};

  // Default client
  try {
    const { Innertube, Platform } = await import("youtubei.js");
    const yt = await Innertube.create({
      cookie: cookieStatus.envCookiePresent ? process.env.YT_COOKIES || undefined : undefined,
      visitor_data: cookieStatus.visitorDataSet ? process.env.YT_VISITOR_DATA || undefined : undefined,
    });
    const info = await yt.getBasicInfo(videoId);
    results.default = {
      hasStreamingData: !!info.streaming_data,
      playabilityStatus: info.playability_status?.status,
      formatCount: info.streaming_data ? (info.streaming_data.formats?.length || 0) + (info.streaming_data.adaptive_formats?.length || 0) : 0,
    };
  } catch (e: any) {
    results.default = { error: e?.message?.slice(0, 100) };
  }

  // Alternative clients
  for (const client of CLIENTS) {
    try {
      const { Innertube, Platform } = await import("youtubei.js");
      const yt = await Innertube.create({
        client_type: client as any,
        cookie: cookieStatus.envCookiePresent ? process.env.YT_COOKIES || undefined : undefined,
        visitor_data: cookieStatus.visitorDataSet ? process.env.YT_VISITOR_DATA || undefined : undefined,
      });
      const info = await yt.getBasicInfo(videoId);
      results[client] = {
        hasStreamingData: !!info.streaming_data,
        playabilityStatus: info.playability_status?.status,
        formatCount: info.streaming_data ? (info.streaming_data.formats?.length || 0) + (info.streaming_data.adaptive_formats?.length || 0) : 0,
      };
    } catch (e: any) {
      results[client] = { error: e?.message?.slice(0, 100) };
    }
  }

  // Test without cookies (some clients serve public videos without auth)
  for (const label of ["default", "ANDROID"]) {
    try {
      const { Innertube, Platform } = await import("youtubei.js");
      const config: Record<string, any> = {
        visitor_data: cookieStatus.visitorDataSet ? process.env.YT_VISITOR_DATA || undefined : undefined,
      };
      if (label !== "default") config.client_type = label;
      const yt = await Innertube.create(config);
      const info = await yt.getBasicInfo(videoId);
      results[`${label}_no_cookies`] = {
        hasStreamingData: !!info.streaming_data,
        playabilityStatus: info.playability_status?.status,
        formatCount: info.streaming_data ? (info.streaming_data.formats?.length || 0) + (info.streaming_data.adaptive_formats?.length || 0) : 0,
      };
    } catch (e: any) {
      results[`${label}_no_cookies`] = { error: e?.message?.slice(0, 100) };
    }
  }

  return c.json({ cookieStatus, results });
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
