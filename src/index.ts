import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import YTMusic from "ytmusic-api";

let ytmusic: YTMusic | null = null;

async function getYTMusic(): Promise<YTMusic> {
  if (ytmusic) return ytmusic;
  ytmusic = new YTMusic();
  await ytmusic.initialize();
  console.log("blu3 in");
  return ytmusic;
}

getYTMusic().catch(console.error);

const app = new Hono();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: ["http://localhost:3000"],
    allowMethods: ["GET"],
  }),
);

app.get("/", (c) => c.json({ status: "ok", service: "ytaudio-api" }));

app.get("/api/search", async (c) => {
  const q = c.req.query("q");
  if (!q?.trim()) return c.json({ tracks: [] });

  try {
    const yt = await getYTMusic();
    const results = await yt.searchSongs(q);

    const tracks = results
      .filter((r) => r.videoId) // skip results with no playable ID
      .map((r) => {
        const thumbs = r.thumbnails ?? [];
        const rawThumb = thumbs[thumbs.length - 1]?.url ?? "";
        // Force square high-res thumbnail
        const image = rawThumb.replace(/=w\d+-h\d+.*$/, "=w226-h226-l90-rj");

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
    ytmusic = null; // reset on error so next request reinitializes
    return c.json({ error: "Search failed" }, 500);
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
    // response is JSONP-like: window.google.ac.h([...])
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

serve({ fetch: app.fetch, port: 8000 }, (info) => {
  console.log(`blu3 API running on http://localhost:${info.port}`);
});
