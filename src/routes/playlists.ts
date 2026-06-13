import { Hono, type MiddlewareHandler } from "hono";
import { db } from "../db/index.js";
import { playlists, playlistTracks } from "../db/schema.js";
import { eq, and, desc, asc } from "drizzle-orm";
import { searchJioSaavnResults } from "../lib/jiosaavnAudio.js";
import { getSessionFromRequest } from "../lib/auth.js";
import { getCached, setCache } from "../lib/responseCache.js";

type PlaylistsEnv = {
  Variables: {
    userId: string;
  };
};

const playlistsRoute = new Hono<PlaylistsEnv>();

const requireAuth: MiddlewareHandler<PlaylistsEnv> = async (c, next) => {
  const session = await getSessionFromRequest(c.req.raw.headers);
  if (!session?.user) return c.json({ error: "Unauthorized" }, 401);
  c.set("userId", session.user.id);
  await next();
};

playlistsRoute.use("*", requireAuth);

function parseISO8601Duration(duration: string): number {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || "0", 10);
  const minutes = parseInt(match[2] || "0", 10);
  const seconds = parseInt(match[3] || "0", 10);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000;
}

function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

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

interface AppleMusicURLParts {
  storefront: string;
  playlistId: string;
}

function parseAppleMusicURL(url: string): AppleMusicURLParts | null {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const playlistIdx = segments.findIndex(s => s === "playlist");
    if (playlistIdx < 1 || playlistIdx >= segments.length - 1) return null;
    return {
      storefront: segments[playlistIdx - 1],
      playlistId: segments[segments.length - 1],
    };
  } catch {
    return null;
  }
}

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAppleMusicToken(): Promise<string | null> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }
  try {
    const mainRes = await fetch("https://beta.music.apple.com", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    if (!mainRes.ok) return null;
    const html = await mainRes.text();
    const jsUri = html.match(/\/assets\/index-legacy[~-][^/]+\.js/)?.[0];
    if (!jsUri) return null;

    const jsRes = await fetch(`https://beta.music.apple.com${jsUri}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    if (!jsRes.ok) return null;
    const js = await jsRes.text();
    const token = js.match(/['\x60"](eyJ[a-zA-Z0-9_-]+?\.[a-zA-Z0-9_-]+?\.[a-zA-Z0-9_-]+)['\x60"]/)?.[1];
    if (!token) return null;

    cachedToken = { token, expiresAt: Date.now() + 10 * 60 * 1000 };
    return token;
  } catch (err) {
    console.error("Apple Music token fetch failed:", err);
    return null;
  }
}

async function getAppleMusicPlaylistTracks(url: string): Promise<{ name: string; tracks: ScrapedSpotifyTrack[] } | null> {
  try {
    const parts = parseAppleMusicURL(url);
    if (!parts) return null;

    const token = await getAppleMusicToken();
    if (!token) return null;

    const allTracks: ScrapedSpotifyTrack[] = [];
    let playlistName = "Imported Apple Music Playlist";
    let offset = 0;

    while (true) {
      const apiUrl = `https://amp-api.music.apple.com/v1/catalog/${parts.storefront}/playlists/${parts.playlistId}?include=tracks&offset=${offset}`;
      const res = await fetch(apiUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Origin: "https://music.apple.com",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
      });
      if (!res.ok) return null;

      const data = await res.json();
      const playlist = data?.data?.[0];
      if (!playlist) return null;

      playlistName = playlist.attributes?.name || playlistName;
      const batch = (playlist.relationships?.tracks?.data || [])
        .filter((item: any) => item.type === "songs")
        .map((item: any) => ({
          trackName: item.attributes?.name || "Unknown Track",
          artistName: item.attributes?.artistName || "Unknown Artist",
        }));

      allTracks.push(...batch);

      if (batch.length < 100 || allTracks.length >= 200) break;
      offset += 100;
    }

    if (allTracks.length === 0) return null;

    return { name: playlistName, tracks: allTracks };
  } catch (err) {
    console.error("Apple Music scrape failed:", err);
    return null;
  }
}

function normalizeStr(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function isMatch(title: string, artist: string, expectedTitle: string, expectedArtist: string): boolean {
  const cleanTitle = normalizeStr(title);
  const cleanArtist = normalizeStr(artist);
  const cleanExpectedTitle = normalizeStr(expectedTitle);
  const cleanExpectedArtist = normalizeStr(expectedArtist);

  const titleMatch = cleanTitle.includes(cleanExpectedTitle) || cleanExpectedTitle.includes(cleanTitle);
  const titleWords = cleanExpectedTitle.split(" ");
  const partialTitle = titleWords.slice(0, Math.min(3, titleWords.length)).join(" ");
  const partialMatch = partialTitle.length > 3 && cleanTitle.includes(partialTitle);

  const hasArtist = cleanExpectedArtist.length > 0 && cleanExpectedArtist !== "unknown artist";
  const artistMatch = !hasArtist ||
    cleanArtist.includes(cleanExpectedArtist) ||
    cleanExpectedArtist.includes(cleanArtist) ||
    cleanExpectedArtist.split(" ").some((w: string) => w.length > 2 && cleanArtist.includes(w));

  return (titleMatch || partialMatch) && artistMatch;
}

async function resolveTrackToJioSaavn(
  trackName: string,
  artistName: string,
): Promise<{ videoId: string; image: string; durationMs: number }> {
  const query = `${trackName} ${artistName !== "Unknown Artist" ? artistName : ""}`.trim();
  try {
    const results = await searchJioSaavnResults(query);
    const match = results.find((r) =>
      isMatch(r.name, r.artists[0]?.name || "", trackName, artistName)
    );
    if (match) {
      return {
        videoId: match.videoId,
        image: match.image,
        durationMs: match.duration_ms,
      };
    }
    if (results.length > 0) {
      const track = results[0];
      return {
        videoId: track.videoId,
        image: track.image,
        durationMs: track.duration_ms,
      };
    }
  } catch (err) {
    console.error("JioSaavn search failed:", err);
  }
  return { videoId: "", image: "", durationMs: 0 };
}

interface JioSaavnPlaylistTrack {
  id: string;
  title: string;
  artists: string;
  image: string;
  duration: number;
}

async function getJioSaavnPlaylistTracks(url: string): Promise<{ name: string; tracks: JioSaavnPlaylistTrack[] } | null> {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const playlistIdx = segments.findIndex((s) => s === "playlist");
    if (playlistIdx < 0 || playlistIdx >= segments.length - 1) return null;
    const playlistId = segments[segments.length - 1];

    const apiUrl = new URL("https://www.jiosaavn.com/api.php");
    apiUrl.searchParams.set("__call", "playlist.getDetails");
    apiUrl.searchParams.set("_format", "json");
    apiUrl.searchParams.set("cc", "in");
    apiUrl.searchParams.set("_marker", "0");
    apiUrl.searchParams.set("listid", playlistId);

    const res = await fetch(apiUrl.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://www.jiosaavn.com/",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const list = data?.list ? JSON.parse(data.list) : data;
    const songs: any[] = list?.songs ?? [];

    return {
      name: list?.title || data?.title || "Imported JioSaavn Playlist",
      tracks: songs.map((s: any) => ({
        id: s.id || "",
        title: s.song || s.title || "Unknown Track",
        artists: s.primary_artists || s.singers || s.music || "Unknown Artist",
        image: (s.image || "").replace("150x150", "500x500").replace("50x50", "500x500"),
        duration: Number(s.duration) || 0,
      })),
    };
  } catch (err) {
    console.error("JioSaavn playlist fetch failed:", err);
    return null;
  }
}

// ── YouTube Playlist Import ──

interface YouTubePlaylistTrack {
  title: string;
  artist: string;
}

async function getYouTubePlaylistTracks(url: string): Promise<{ name: string; tracks: YouTubePlaylistTrack[] } | null> {
  try {
    const ytRegex = /[&?]list=([a-zA-Z0-9_-]+)/;
    const match = url.match(ytRegex);
    const playlistId = match ? match[1] : null;
    if (!playlistId) return null;

    const res = await fetch(`https://www.youtube.com/playlist?list=${playlistId}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const html = await res.text();

    const matchData = html.match(/ytInitialData\s*=\s*({.+?});\s*<\/script>/s);
    if (!matchData) return null;
    const data = JSON.parse(matchData[1]);

    const tabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs ?? [];
    const tabContent = tabs[0]?.tabRenderer?.content ?? {};
    const sectionList = tabContent.sectionListRenderer?.contents ?? [];
    const itemSection = sectionList[0]?.itemSectionRenderer?.contents ?? [];
    const playlistRenderer = itemSection[0]?.playlistVideoListRenderer?.contents ?? [];

    const playlistTitle =
      data?.metadata?.playlistMetadataRenderer?.title ||
      data?.header?.playlistHeaderRenderer?.title?.simpleText ||
      "Imported YouTube Playlist";

    const tracks: YouTubePlaylistTrack[] = [];

    for (const item of playlistRenderer) {
      const video = item?.playlistVideoRenderer ?? {};
      const titleRun = video?.title?.runs?.[0];
      const title = titleRun?.text ?? "";
      if (!title) continue;

      const shortByline = video?.shortBylineText?.runs ?? [];
      const channelName = shortByline.map((r: any) => r.text).join("") || "Unknown Artist";
      const artistName = channelName.replace(/ - Topic$/, "").trim();

      tracks.push({ title, artist: artistName || "Unknown Artist" });
    }

    if (tracks.length === 0) return null;
    return { name: playlistTitle, tracks };
  } catch (err) {
    console.error("YouTube playlist fetch failed:", err);
    return null;
  }
}

// ── YouTube Music fallback using ytmusic-api ──

async function getYouTubeMusicPlaylistTracks(
  playlistId: string,
): Promise<{ name: string; tracks: YouTubePlaylistTrack[] } | null> {
  try {
    const { default: YTMusic } = await import("ytmusic-api");
    const yt = new YTMusic();
    await yt.initialize();
    const videos = await yt.getPlaylistVideos(playlistId);
    if (!videos || videos.length === 0) return null;
    const name = await yt
      .getPlaylist(playlistId)
      .then((p: any) => p.name || "Imported YouTube Music Playlist")
      .catch(() => "Imported YouTube Music Playlist");
    const tracks: YouTubePlaylistTrack[] = videos.map((v: any) => ({
      title: v.name || "Unknown",
      artist: v.artist?.name || "Unknown Artist",
    }));
    return { name, tracks };
  } catch (err) {
    console.error("YouTube Music playlist fetch failed:", err);
    return null;
  }
}

// ── ENDPOINTS ──

// GET /api/playlists — Fetch all playlists for current user
playlistsRoute.get("/", async (c) => {
  const userId = c.get("userId");
  const cacheKey = `playlists:${userId}`;
  const cached = getCached(cacheKey);
  if (cached) return c.json(cached);
  try {
    let userPlaylists = await db
      .select()
      .from(playlists)
      .where(eq(playlists.userId, userId))
      .orderBy(asc(playlists.createdAt));

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

    const enriched = await Promise.all(
      userPlaylists.map(async (pl) => {
        const tracks = await db
          .select({ image: playlistTracks.image })
          .from(playlistTracks)
          .where(eq(playlistTracks.playlistId, pl.id))
          .orderBy(asc(playlistTracks.position));

        const coverImage = pl.isLiked ? "/queue/finalheart.jpg" : (tracks.find((t) => t.image)?.image || "");
        return {
          ...pl,
          coverImage,
          trackCount: tracks.length,
        };
      })
    );

    const result = { playlists: enriched };
    setCache(cacheKey, result);
    return c.json(result);
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

    const [existingTrack] = await db
      .select()
      .from(playlistTracks)
      .where(and(eq(playlistTracks.playlistId, likedPlaylist.id), eq(playlistTracks.videoId, videoId)))
      .limit(1);

    if (existingTrack) {
      await db.delete(playlistTracks).where(eq(playlistTracks.id, existingTrack.id));
      return c.json({ liked: false });
    } else {
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

// POST /api/playlists/import — Import a YouTube, Spotify, JioSaavn, or Apple Music playlist, resolving all to JioSaavn songs
playlistsRoute.post("/import", async (c) => {
  const userId = c.get("userId");
  const { url } = await c.req.json();
  if (!url?.trim()) return c.json({ error: "Playlist link is required" }, 400);

  const isYouTube = url.includes("youtube.com") || url.includes("youtu.be");
  const isSpotify = url.includes("spotify.com");
  const isJioSaavn = url.includes("jiosaavn.com");
  const isAppleMusic = url.includes("music.apple.com");

  if (!isYouTube && !isSpotify && !isJioSaavn && !isAppleMusic) {
    return c.json({ error: "Invalid playlist URL. Please provide a YouTube, Spotify, JioSaavn, or Apple Music link." }, 400);
  }

  try {
    if (isYouTube) {
      // ── YouTube Import (scrape → YT Music API fallback → JioSaavn resolve) ──
      let scraped = await getYouTubePlaylistTracks(url);
      if (!scraped || scraped.tracks.length === 0) {
        const ytRegex = /[&?]list=([a-zA-Z0-9_-]+)/;
        const match = url.match(ytRegex);
        const playlistId = match ? match[1] : null;
        if (playlistId) {
          scraped = await getYouTubeMusicPlaylistTracks(playlistId);
        }
      }
      if (!scraped || scraped.tracks.length === 0) {
        return c.json({ error: "Failed to fetch YouTube playlist. Ensure the playlist is public." }, 404);
      }

      const [newPlaylist] = await db
        .insert(playlists)
        .values({
          userId,
          name: scraped.name,
          isLiked: false,
        })
        .returning();

      const tracksToInsert: any[] = [];
      const chunks = chunkArray(scraped.tracks, 5);
      let positionCounter = 0;

      for (const chunk of chunks) {
        const resolvedList = await Promise.all(
          chunk.map(async (item: YouTubePlaylistTrack) => {
            const resolved = await resolveTrackToJioSaavn(item.title, item.artist);
            if (resolved.videoId) {
              return {
                playlistId: newPlaylist.id,
                videoId: resolved.videoId,
                trackName: item.title,
                artistName: item.artist,
                image: resolved.image,
                durationMs: resolved.durationMs,
              };
            }
            return null;
          })
        );

        for (const item of resolvedList) {
          if (item) {
            tracksToInsert.push({ ...item, position: positionCounter++ });
          }
        }
      }

      if (tracksToInsert.length > 0) {
        await db.insert(playlistTracks).values(tracksToInsert);
      }

      return c.json({ playlist: newPlaylist, trackCount: tracksToInsert.length });
    } else if (isJioSaavn) {
      // ── JioSaavn Import ──
      const scraped = await getJioSaavnPlaylistTracks(url);
      if (!scraped || scraped.tracks.length === 0) {
        return c.json({ error: "Failed to fetch JioSaavn playlist. Ensure the playlist is public." }, 404);
      }

      const [newPlaylist] = await db
        .insert(playlists)
        .values({
          userId,
          name: scraped.name,
          isLiked: false,
        })
        .returning();

      const tracksToInsert: any[] = [];
      const chunks = chunkArray(scraped.tracks, 5);
      let positionCounter = 0;

      for (const chunk of chunks) {
        const resolvedList = await Promise.all(
          chunk.map(async (item: JioSaavnPlaylistTrack) => ({
            playlistId: newPlaylist.id,
            videoId: item.id,
            trackName: item.title,
            artistName: item.artists,
            image: item.image,
            durationMs: item.duration * 1000,
          }))
        );

        for (const item of resolvedList) {
          if (item) {
            tracksToInsert.push({ ...item, position: positionCounter++ });
          }
        }
      }

      if (tracksToInsert.length > 0) {
        await db.insert(playlistTracks).values(tracksToInsert);
      }

      return c.json({ playlist: newPlaylist, trackCount: tracksToInsert.length });
    } else if (isAppleMusic) {
      // ── Apple Music Import ──
      const scraped = await getAppleMusicPlaylistTracks(url);
      if (!scraped || scraped.tracks.length === 0) {
        return c.json({ error: "Failed to fetch Apple Music playlist. Ensure the playlist is public." }, 404);
      }

      const [newPlaylist] = await db
        .insert(playlists)
        .values({
          userId,
          name: scraped.name,
          isLiked: false,
        })
        .returning();

      const tracksToInsert: any[] = [];
      const chunks = chunkArray(scraped.tracks, 5);
      let positionCounter = 0;

      for (const chunk of chunks) {
        const resolvedList = await Promise.all(
          chunk.map(async (item: ScrapedSpotifyTrack) => {
            const resolved = await resolveTrackToJioSaavn(
              item.trackName, item.artistName
            );
            if (resolved.videoId) {
              return {
                playlistId: newPlaylist.id,
                videoId: resolved.videoId,
                trackName: item.trackName,
                artistName: item.artistName,
                image: resolved.image,
                durationMs: resolved.durationMs,
              };
            }
            return null;
          })
        );

        for (const item of resolvedList) {
          if (item) {
            tracksToInsert.push({ ...item, position: positionCounter++ });
          }
        }
      }

      if (tracksToInsert.length > 0) {
        await db.insert(playlistTracks).values(tracksToInsert);
      }

      return c.json({ playlist: newPlaylist, trackCount: tracksToInsert.length });
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

      const chunks = chunkArray(tracksToResolve, 5);
      let positionCounter = 0;

      for (const chunk of chunks) {
        const resolvedList = await Promise.all(
          chunk.map(async (item: ScrapedSpotifyTrack) => {
            const trackName = item.trackName;
            const artistName = item.artistName;

            const resolved = await resolveTrackToJioSaavn(trackName, artistName);
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
