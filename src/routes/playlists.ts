import { Hono, type MiddlewareHandler } from "hono";
import { db } from "../db/index.js";
import { playlists, playlistTracks, users } from "../db/schema.js";
import { eq, and, desc, asc } from "drizzle-orm";
import { verify } from "hono/jwt";
import YTMusic from "ytmusic-api";

type PlaylistsEnv = {
  Variables: {
    userId: string;
  };
};

const playlistsRoute = new Hono<PlaylistsEnv>();

// JWT authentication middleware
const requireAuth: MiddlewareHandler<PlaylistsEnv> = async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer "))
    return c.json({ error: "Unauthorized" }, 401);
  try {
    const payload = await verify(
      header.slice(7),
      process.env.JWT_SECRET!,
      "HS256"
    );
    c.set("userId", payload.sub as string);
    await next();
  } catch (err) {
    console.error("Playlist auth error:", err);
    return c.json({ error: "Invalid token" }, 401);
  }
};

playlistsRoute.use("*", requireAuth);

// YTMusic lazy loader helper
let ytmusicInstance: YTMusic | null = null;
async function getYTMusic(): Promise<YTMusic> {
  if (ytmusicInstance) return ytmusicInstance;
  ytmusicInstance = new YTMusic();
  await ytmusicInstance.initialize();
  return ytmusicInstance;
}

// ISO 8601 duration parser (PT3M45S -> milliseconds)
function parseISO8601Duration(duration: string): number {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || "0", 10);
  const minutes = parseInt(match[2] || "0", 10);
  const seconds = parseInt(match[3] || "0", 10);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000;
}

// Chunking utility for API rate limit protection
function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// Spotify Client Credentials Flow Token Generator
async function getSpotifyAccessToken(clientId: string, clientSecret: string): Promise<string | null> {
  try {
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    const data = await res.json();
    return data.access_token || null;
  } catch (err) {
    console.error("Spotify Auth Failed:", err);
    return null;
  }
}

interface ScrapedSpotifyTrack {
  trackName: string;
  artistName: string;
}

async function getSpotifyPlaylistTracksViaEmbed(playlistId: string): Promise<{ name: string; tracks: ScrapedSpotifyTrack[] } | null> {
  try {
    const url = `https://open.spotify.com/embed/playlist/${playlistId}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    if (!res.ok) return null;
    const html = await res.text();
    const nextDataMatch = html.match(/<script.*?id="__NEXT_DATA__".*?>(.*?)<\/script>/s);
    if (!nextDataMatch) return null;
    
    const parsed = JSON.parse(nextDataMatch[1]);
    const entity = parsed?.props?.pageProps?.state?.data?.entity;
    if (!entity) return null;
    
    const name = entity.name || "Imported Spotify Playlist";
    const trackList = entity.trackList || [];
    
    const tracks = trackList.map((item: any) => ({
      trackName: item.title || "Unknown Track",
      artistName: item.subtitle || "Unknown Artist",
    }));
    
    return { name, tracks };
  } catch (err) {
    console.error("Spotify Embed Scrape failed:", err);
    return null;
  }
}

// Resolves a Spotify track by name + artist to a playable YouTube video details object
async function resolveSpotifyTrackToYouTube(
  trackName: string,
  artistName: string,
  ytmusic: YTMusic
): Promise<{ videoId: string; image: string; durationMs: number }> {
  const query = `${trackName} ${artistName}`;
  const apiKey = process.env.YOUTUBE_API_KEY;

  // 1. Prioritize ytmusic-api to get high quality square track/album art
  try {
    const results = await ytmusic.searchSongs(query);
    const song = results[0];
    if (song && song.videoId) {
      const thumbs = song.thumbnails ?? [];
      const rawThumb = thumbs[thumbs.length - 1]?.url ?? "";
      const image = rawThumb.replace(/=w\d+-h\d+.*$/, "=w226-h226-l90-rj");
      return {
        videoId: song.videoId,
        image,
        durationMs: (song.duration ?? 0) * 1000 || 180000,
      };
    }
  } catch (err) {
    console.error("ytmusic-api search failed, trying YouTube API:", err);
  }

  // 2. Fallback to regular YouTube Search API if ytmusic fails or has no tracks
  if (apiKey) {
    try {
      // Search YouTube v3 API
      const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&key=${apiKey}&maxResults=1`;
      const searchRes = await fetch(searchUrl);
      const searchData = await searchRes.json();
      const videoItem = searchData.items?.[0];

      if (videoItem) {
        const videoId = videoItem.id.videoId;
        const image = videoItem.snippet.thumbnails?.high?.url || videoItem.snippet.thumbnails?.default?.url || "";

        // Fetch duration details
        const detailsUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${videoId}&key=${apiKey}`;
        const detailsRes = await fetch(detailsUrl);
        const detailsData = await detailsRes.json();
        const durationStr = detailsData.items?.[0]?.contentDetails?.duration;

        let durationMs = 180000; // default 3 min fallback
        if (durationStr) {
          durationMs = parseISO8601Duration(durationStr);
        }

        return { videoId, image, durationMs };
      }
    } catch (err) {
      console.error("YouTube Search API failed:", err);
    }
  }

  return { videoId: "", image: "", durationMs: 0 };
}

// ── ENDPOINTS ──

// GET /api/playlists — Fetch all playlists for current user (Self-Healing "Liked Songs")
playlistsRoute.get("/", async (c) => {
  const userId = c.get("userId");
  try {
    let userPlaylists = await db
      .select()
      .from(playlists)
      .where(eq(playlists.userId, userId))
      .orderBy(asc(playlists.createdAt));

    // Self-healing check: Ensure "Liked Songs" exists
    const hasLiked = userPlaylists.some((p) => p.isLiked);
    if (!hasLiked) {
      const [likedPlaylist] = await db
        .insert(playlists)
        .values({
          userId,
          name: "Liked Songs",
          isLiked: true,
        })
        .returning();
      
      userPlaylists = [likedPlaylist, ...userPlaylists];
    }

    return c.json({ playlists: userPlaylists });
  } catch (err) {
    console.error("Failed to fetch playlists:", err);
    return c.json({ error: "Failed to fetch playlists" }, 500);
  }
});

// GET /api/playlists/liked/ids — Return array of videoIds in Liked Songs playlist for fast toggles
playlistsRoute.get("/liked/ids", async (c) => {
  const userId = c.get("userId");
  try {
    let [likedPlaylist] = await db
      .select()
      .from(playlists)
      .where(and(eq(playlists.userId, userId), eq(playlists.isLiked, true)))
      .limit(1);

    if (!likedPlaylist) {
      // Auto-create if not found
      [likedPlaylist] = await db
        .insert(playlists)
        .values({
          userId,
          name: "Liked Songs",
          isLiked: true,
        })
        .returning();
    }

    const tracks = await db
      .select({ videoId: playlistTracks.videoId })
      .from(playlistTracks)
      .where(eq(playlistTracks.playlistId, likedPlaylist.id));

    return c.json({ ids: tracks.map((t) => t.videoId) });
  } catch (err) {
    console.error("Failed to get liked ids:", err);
    return c.json({ ids: [] });
  }
});

// GET /api/playlists/:id — Fetch a single playlist and its tracks
playlistsRoute.get("/:id", async (c) => {
  const userId = c.get("userId");
  const playlistId = c.req.param("id");

  try {
    const [playlist] = await db
      .select()
      .from(playlists)
      .where(and(eq(playlists.id, playlistId), eq(playlists.userId, userId)))
      .limit(1);

    if (!playlist) return c.json({ error: "Playlist not found" }, 404);

    const tracks = await db
      .select()
      .from(playlistTracks)
      .where(eq(playlistTracks.playlistId, playlistId))
      .orderBy(asc(playlistTracks.position));

    return c.json({ playlist, tracks });
  } catch (err) {
    console.error("Failed to fetch playlist tracks:", err);
    return c.json({ error: "Failed to fetch playlist details" }, 500);
  }
});

// POST /api/playlists — Create a custom blank playlist
playlistsRoute.post("/", async (c) => {
  const userId = c.get("userId");
  const { name } = await c.req.json();
  if (!name?.trim()) return c.json({ error: "Playlist name is required" }, 400);

  try {
    const [playlist] = await db
      .insert(playlists)
      .values({
        userId,
        name: name.trim(),
        isLiked: false,
      })
      .returning();

    return c.json({ playlist });
  } catch (err) {
    console.error("Failed to create playlist:", err);
    return c.json({ error: "Failed to create playlist" }, 500);
  }
});

// DELETE /api/playlists/:id — Delete custom playlist (not Liked Songs)
playlistsRoute.delete("/:id", async (c) => {
  const userId = c.get("userId");
  const playlistId = c.req.param("id");

  try {
    const [playlist] = await db
      .select()
      .from(playlists)
      .where(and(eq(playlists.id, playlistId), eq(playlists.userId, userId)))
      .limit(1);

    if (!playlist) return c.json({ error: "Playlist not found" }, 404);
    if (playlist.isLiked) return c.json({ error: "Cannot delete Liked Songs playlist" }, 403);

    await db.delete(playlists).where(eq(playlists.id, playlistId));
    return c.json({ success: true });
  } catch (err) {
    console.error("Failed to delete playlist:", err);
    return c.json({ error: "Failed to delete playlist" }, 500);
  }
});

// POST /api/playlists/liked/toggle — Heart / Like button toggle action
playlistsRoute.post("/liked/toggle", async (c) => {
  const userId = c.get("userId");
  const { videoId, trackName, artistName, image, durationMs } = await c.req.json();
  if (!videoId) return c.json({ error: "videoId is required" }, 400);

  try {
    // 1. Get or create Liked Songs playlist
    let [likedPlaylist] = await db
      .select()
      .from(playlists)
      .where(and(eq(playlists.userId, userId), eq(playlists.isLiked, true)))
      .limit(1);

    if (!likedPlaylist) {
      [likedPlaylist] = await db
        .insert(playlists)
        .values({
          userId,
          name: "Liked Songs",
          isLiked: true,
        })
        .returning();
    }

    // 2. Check if track is already in this playlist
    const [existingTrack] = await db
      .select()
      .from(playlistTracks)
      .where(and(eq(playlistTracks.playlistId, likedPlaylist.id), eq(playlistTracks.videoId, videoId)))
      .limit(1);

    if (existingTrack) {
      // Unlike: remove it
      await db.delete(playlistTracks).where(eq(playlistTracks.id, existingTrack.id));
      return c.json({ liked: false });
    } else {
      // Like: append it
      const [maxPos] = await db
        .select({ pos: playlistTracks.position })
        .from(playlistTracks)
        .where(eq(playlistTracks.playlistId, likedPlaylist.id))
        .orderBy(desc(playlistTracks.position))
        .limit(1);

      const nextPos = (maxPos?.pos ?? -1) + 1;

      await db.insert(playlistTracks).values({
        playlistId: likedPlaylist.id,
        videoId,
        trackName: trackName || "Unknown Track",
        artistName: artistName || "Unknown Artist",
        image: image || "",
        durationMs: durationMs || 0,
        position: nextPos,
      });

      return c.json({ liked: true });
    }
  } catch (err) {
    console.error("Like toggle failed:", err);
    return c.json({ error: "Like toggle failed" }, 500);
  }
});

// POST /api/playlists/import — Import a Spotify or YouTube Music playlist link
playlistsRoute.post("/import", async (c) => {
  const userId = c.get("userId");
  const { url } = await c.req.json();
  if (!url?.trim()) return c.json({ error: "Playlist link is required" }, 400);

  const isSpotify = url.includes("spotify.com");
  const isYouTube = url.includes("youtube.com") || url.includes("youtu.be");

  if (!isSpotify && !isYouTube) {
    return c.json({ error: "Invalid playlist URL. Please provide a Spotify or YouTube Music link." }, 400);
  }

  try {
    const ytmusic = await getYTMusic();

    if (isYouTube) {
      // ── YouTube Music Import ──
      const ytRegex = /[&?]list=([a-zA-Z0-9_-]+)/;
      const match = url.match(ytRegex);
      const playlistId = match ? match[1] : null;

      if (!playlistId) return c.json({ error: "Could not parse playlist ID from URL" }, 400);

      const meta = await ytmusic.getPlaylist(playlistId);
      const rawVideos = await ytmusic.getPlaylistVideos(playlistId);

      const [newPlaylist] = await db
        .insert(playlists)
        .values({
          userId,
          name: meta.name || "Imported YouTube Playlist",
          isLiked: false,
        })
        .returning();

      if (rawVideos.length > 0) {
        const tracksToInsert = rawVideos.map((video, idx) => {
          const thumbs = video.thumbnails ?? [];
          const rawThumb = thumbs[thumbs.length - 1]?.url ?? "";
          const image = rawThumb.replace(/=w\d+-h\d+.*$/, "=w226-h226-l90-rj");

          return {
            playlistId: newPlaylist.id,
            videoId: video.videoId,
            trackName: video.name,
            artistName: video.artist?.name || "Unknown Artist",
            image,
            durationMs: (video.duration ?? 0) * 1000 || 180000,
            position: idx,
          };
        });

        await db.insert(playlistTracks).values(tracksToInsert);
      }

      return c.json({ playlist: newPlaylist, trackCount: rawVideos.length });
    } else {
      // ── Spotify Import ──
      const spotifyRegex = /playlist\/([a-zA-Z0-9]+)/;
      const match = url.match(spotifyRegex);
      const playlistId = match ? match[1] : null;

      if (!playlistId) return c.json({ error: "Could not parse Spotify playlist ID from URL" }, 400);

      let playlistName = "Imported Spotify Playlist";
      let tracksToResolve: ScrapedSpotifyTrack[] = [];
      let fetchedSuccessfully = false;

      const clientId = process.env.SPOTIFY_CLIENT_ID;
      const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

      if (clientId && clientSecret) {
        try {
          const accessToken = await getSpotifyAccessToken(clientId, clientSecret);
          if (accessToken) {
            // Fetch playlist details
            const spotifyRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}`, {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (spotifyRes.ok) {
              const playlistData = await spotifyRes.json();
              playlistName = playlistData.name || "Imported Spotify Playlist";
              const spotifyItems = playlistData.tracks?.items || [];
              tracksToResolve = spotifyItems.map((item: any) => ({
                trackName: item?.track?.name || "Unknown Track",
                artistName: item?.track?.artists?.map((a: any) => a.name).join(", ") || "Unknown Artist",
              }));
              fetchedSuccessfully = true;
            } else {
              console.warn("Spotify API fetch failed with status:", spotifyRes.status);
            }
          }
        } catch (err) {
          console.error("Spotify API process failed, falling back:", err);
        }
      }

      if (!fetchedSuccessfully) {
        console.log("Using public Spotify Embed scraper fallback for playlist:", playlistId);
        const scraped = await getSpotifyPlaylistTracksViaEmbed(playlistId);
        if (scraped) {
          playlistName = scraped.name;
          tracksToResolve = scraped.tracks;
          fetchedSuccessfully = true;
        }
      }

      if (!fetchedSuccessfully) {
        return c.json({ error: "Failed to fetch Spotify playlist. Ensure the playlist is public." }, 404);
      }

      const [newPlaylist] = await db
        .insert(playlists)
        .values({
          userId,
          name: playlistName,
          isLiked: false,
        })
        .returning();

      const tracksToInsert: any[] = [];

      // Concurrently resolve tracks in chunks of 5
      const chunks = chunkArray(tracksToResolve, 5);
      let positionCounter = 0;

      for (const chunk of chunks) {
        const resolvedList = await Promise.all(
          chunk.map(async (item: ScrapedSpotifyTrack) => {
            const trackName = item.trackName;
            const artistName = item.artistName;

            const resolved = await resolveSpotifyTrackToYouTube(trackName, artistName, ytmusic);
            if (resolved.videoId) {
              return {
                playlistId: newPlaylist.id,
                videoId: resolved.videoId,
                trackName,
                artistName,
                image: resolved.image,
                durationMs: resolved.durationMs,
              };
            }
            return null;
          })
        );

        for (const item of resolvedList) {
          if (item) {
            tracksToInsert.push({
              ...item,
              position: positionCounter++,
            });
          }
        }
      }

      if (tracksToInsert.length > 0) {
        await db.insert(playlistTracks).values(tracksToInsert);
      }

      return c.json({ playlist: newPlaylist, trackCount: tracksToInsert.length });
    }
  } catch (err) {
    console.error("Playlist import failed:", err);
    return c.json({ error: "Playlist import failed" }, 500);
  }
});

// DELETE /api/playlists/:id/tracks/:trackId — Delete a track from a custom playlist
playlistsRoute.delete("/:id/tracks/:trackId", async (c) => {
  const userId = c.get("userId");
  const playlistId = c.req.param("id");
  const trackId = c.req.param("trackId");

  try {
    const [playlist] = await db
      .select()
      .from(playlists)
      .where(and(eq(playlists.id, playlistId), eq(playlists.userId, userId)))
      .limit(1);

    if (!playlist) return c.json({ error: "Playlist not found" }, 404);

    await db
      .delete(playlistTracks)
      .where(and(eq(playlistTracks.playlistId, playlistId), eq(playlistTracks.id, trackId)));

    return c.json({ success: true });
  } catch (err) {
    console.error("Failed to delete track from playlist:", err);
    return c.json({ error: "Failed to delete track" }, 500);
  }
});

// POST /api/playlists/:id/tracks — Add a track to a custom playlist
playlistsRoute.post("/:id/tracks", async (c) => {
  const userId = c.get("userId");
  const playlistId = c.req.param("id");
  const { videoId, trackName, artistName, image, durationMs } = await c.req.json();

  if (!videoId || !trackName) {
    return c.json({ error: "videoId and trackName are required" }, 400);
  }

  try {
    const [playlist] = await db
      .select()
      .from(playlists)
      .where(and(eq(playlists.id, playlistId), eq(playlists.userId, userId)))
      .limit(1);

    if (!playlist) return c.json({ error: "Playlist not found" }, 404);

    const [maxPos] = await db
      .select({ pos: playlistTracks.position })
      .from(playlistTracks)
      .where(eq(playlistTracks.playlistId, playlistId))
      .orderBy(desc(playlistTracks.position))
      .limit(1);

    const nextPos = (maxPos?.pos ?? -1) + 1;

    const [newTrack] = await db
      .insert(playlistTracks)
      .values({
        playlistId,
        videoId,
        trackName,
        artistName: artistName || "Unknown Artist",
        image: image || "",
        durationMs: durationMs || 0,
        position: nextPos,
      })
      .returning();

    return c.json({ track: newTrack });
  } catch (err) {
    console.error("Failed to add track to playlist:", err);
    return c.json({ error: "Failed to add track" }, 500);
  }
});

// PUT /api/playlists/:id/tracks/reorder — Reorder tracks in a playlist
playlistsRoute.put("/:id/tracks/reorder", async (c) => {
  const userId = c.get("userId");
  const playlistId = c.req.param("id");
  const { trackIds } = await c.req.json();

  if (!Array.isArray(trackIds)) {
    return c.json({ error: "trackIds array is required" }, 400);
  }

  try {
    const [playlist] = await db
      .select()
      .from(playlists)
      .where(and(eq(playlists.id, playlistId), eq(playlists.userId, userId)))
      .limit(1);

    if (!playlist) return c.json({ error: "Playlist not found" }, 404);

    await Promise.all(
      trackIds.map(async (trackId: string, idx: number) => {
        await db
          .update(playlistTracks)
          .set({ position: idx })
          .where(and(eq(playlistTracks.playlistId, playlistId), eq(playlistTracks.id, trackId)));
      })
    );

    return c.json({ success: true });
  } catch (err) {
    console.error("Failed to reorder playlist tracks:", err);
    return c.json({ error: "Failed to reorder tracks" }, 500);
  }
});

export default playlistsRoute;
