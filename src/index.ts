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
import { getCookieStatus } from "./lib/stream.js";

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

app.get("/debug", async (c) => {
  return c.json({
    status: "ok",
    stream: "disabled — using YT IFrame API directly (Vibe-style)",
    cookies: getCookieStatus(),
  });
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
