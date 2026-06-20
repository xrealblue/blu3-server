import { Hono } from "hono";
import { getSessionFromRequest } from "../lib/auth.js";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { eq } from "drizzle-orm";
import { extractAudioUrl, getCachedAudioUrl, getStream, searchYouTube } from "../lib/ytAudio.js";

const audioFallbackRoute = new Hono();

// POST /api/resolve-fallback — resolve a non-JioSaavn track to YouTube audio
audioFallbackRoute.post("/resolve-fallback", async (c) => {
  const session = await getSessionFromRequest(c.req.raw.headers);
  if (!session?.user) return c.json({ error: "Unauthorized" }, 401);

  let body: { name?: string; artists?: string; videoId?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    let videoId = body.videoId;

    if (!videoId && body.name?.trim()) {
      const query = `${body.name} ${body.artists || ""}`.trim();
      const foundId = await searchYouTube(query);
      if (!foundId) {
        return c.json({ error: "No YouTube video found" }, 404);
      }
      videoId = foundId;
    }

    if (!videoId) {
      return c.json({ error: "Missing name or videoId" }, 400);
    }

    const audioUrl = await extractAudioUrl(videoId);

    return c.json({
      source: "youtube",
      videoId,
      audioUrl: `/api/yt-audio/${videoId}`,
      directUrl: audioUrl,
    });
  } catch (err) {
    console.error("[ResolveFallback] error:", err);
    return c.json({ error: "Failed to resolve audio" }, 500);
  }
});

// GET /api/yt-audio/:videoId — proxy YouTube audio stream
audioFallbackRoute.get("/yt-audio/:videoId", async (c) => {
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

  try {
    const cached = getCachedAudioUrl(videoId);
    if (cached) {
      const redirectRes = await fetch(cached, {
        headers: {
          Range: c.req.header("Range") || "",
        },
      });

      const responseHeaders: Record<string, string> = {};
      redirectRes.headers.forEach((value, key) => {
        if (
          ["content-type", "content-length", "content-range", "accept-ranges"].includes(
            key.toLowerCase(),
          )
        ) {
          responseHeaders[key] = value;
        }
      });
      responseHeaders["Cache-Control"] = "private, max-age=3600";

      return c.newResponse(redirectRes.body as any, redirectRes.status as any, responseHeaders);
    }

    const streamRes = await getStream(videoId, c.req.header("Range") || "");

    const responseHeaders: Record<string, string> = {};
    streamRes.headers.forEach((value, key) => {
      if (
        ["content-type", "content-length", "content-range", "accept-ranges"].includes(
          key.toLowerCase(),
        )
      ) {
        responseHeaders[key] = value;
      }
    });
    responseHeaders["Cache-Control"] = "private, max-age=3600";
    responseHeaders["Accept-Ranges"] = "bytes";

    return c.newResponse(streamRes.body as any, streamRes.status as any, responseHeaders);
  } catch (err) {
    console.error(`[YTAudio] error for ${videoId}:`, err);
    return c.json({ error: "YouTube audio unavailable" }, 502);
  }
});

export default audioFallbackRoute;
