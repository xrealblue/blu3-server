import { Hono } from "hono";
import playdl from "play-dl";
const app = new Hono();
// Get audio stream URL for a videoId
app.get("/:videoId", async (c) => {
    const videoId = c.req.param("videoId");
    if (!videoId) {
        return c.json({ error: "Missing videoId" }, 400);
    }
    try {
        // Get stream URL using play-dl
        const url = `https://www.youtube.com/watch?v=${videoId}`;
        const stream = await playdl.stream(url, { quality: 1 });
        if (!stream?.url) {
            return c.json({ error: "Could not get stream URL" }, 500);
        }
        return c.json({
            streamUrl: stream.url,
            expiresIn: 7200, // 2 hours typical expiry
        });
    }
    catch (err) {
        console.error("Stream error:", err);
        return c.json({ error: "Failed to get stream" }, 500);
    }
});
export default app;
