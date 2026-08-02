import { Hono, type MiddlewareHandler } from "hono";
import { db } from "../db/index.js";
import { playlists, playlistTracks } from "../db/schema.js";
import { eq, and, desc, asc } from "drizzle-orm";
import { searchJioSaavnResults } from "../lib/jiosaavnAudio.js";
import { searchYouTubeWithMetadata } from "../lib/ytAudio.js";
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
  durationMs?: number;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
}

async function getSpotifyTracksViaEmbed(spotifyType: "playlist" | "album", spotifyId: string): Promise<{ name: string; tracks: ScrapedSpotifyTrack[] } | null> {
  try {
    const url = `https://open.spotify.com/${spotifyType}/${spotifyId}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
      }
    });
    if (!res.ok) return null;
    const html = await res.text();

    const titleMatch = html.match(/<title>(.+?)<\/title>/i);
    const name = titleMatch ? decodeHtmlEntities(titleMatch[1]).replace(/\s*\|\s*Spotify\s*(Playlist|Album)?$/i, "").trim() : "Imported Spotify Playlist";

    const trackNameRegex = /aria-label="([^"]+)"\s+data-testid="track-row"/g;
    const trackNames: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = trackNameRegex.exec(html)) !== null) {
      const raw = m[1].replace(/\s*Explicit\s*/gi, "").trim();
      if (raw) trackNames.push(decodeHtmlEntities(raw));
    }
    if (trackNames.length === 0) return null;

    const parts = html.split('data-testid="track-row"');
    const artistRegex = /data-testid="internal-artist-link">[^<]*<a[^>]*>([^<]+)<\/a>/g;
    const albumArtistRegex = /href="\/artist\/[^"]+"[^>]*>([^<]+)<\/a>/g;
    const tracks: ScrapedSpotifyTrack[] = [];

    for (let i = 0; i < trackNames.length; i++) {
      const part = parts[i + 1] || "";
      const artists: string[] = [];
      let am: RegExpExecArray | null;
      const isAlbum = spotifyType === "album";
      const artistSource = isAlbum ? albumArtistRegex : artistRegex;
      artistSource.lastIndex = 0;
      while ((am = artistSource.exec(part)) !== null) {
        const name = decodeHtmlEntities(am[1].trim());
        if (!artists.includes(name)) artists.push(name);
      }
      const artistName = artists.length > 0 ? artists.join(", ") : "Unknown Artist";
      tracks.push({ trackName: trackNames[i], artistName });
    }

    return { name, tracks };
  } catch (err) {
    console.error("Spotify main page scrape failed:", err);
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
    const jsUri = html.match(/\/assets\/index(?:-legacy)?[~-][^/"]+\.js/)?.[0];
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
        .map((item: any) => {
          const attrs = item.attributes || {};
          const artwork = attrs.artwork || {};
          const imageUrl = artwork.url
            ? artwork.url.replace("{w}", artwork.width || "500").replace("{h}", artwork.height || "500")
            : "";
          const durationMs = typeof attrs.durationInMillis === "number" ? attrs.durationInMillis : 0;
          return {
            trackName: attrs.name || "Unknown Track",
            artistName: attrs.artistName || "Unknown Artist",
            image: imageUrl,
            durationMs,
          };
        });

      allTracks.push(...batch);

      const total = playlist.relationships?.tracks?.meta?.total || batch.length;
      if (batch.length < 100 || allTracks.length >= total) break;
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

function isDurationMatch(actualMs: number, expectedMs: number | undefined): boolean {
  if (!expectedMs || !actualMs) return true;
  return Math.abs(actualMs - expectedMs) < 3000;
}

async function resolveTrackToJioSaavn(
  trackName: string,
  artistName: string,
  durationMs?: number,
): Promise<{ videoId: string; source: string; image: string; durationMs: number }> {
  const timeout = new Promise<{ videoId: ""; source: ""; image: ""; durationMs: 0 }>((resolve) =>
    setTimeout(() => resolve({ videoId: "", source: "", image: "", durationMs: 0 }), 15000),
  );
  const resolve = (async () => {
    const query = `${trackName} ${artistName !== "Unknown Artist" ? artistName : ""}`.trim();
    try {
      const [results, yt] = await Promise.all([
        searchJioSaavnResults(query),
        searchYouTubeWithMetadata(query).catch(() => null),
      ]);
      const match = results.find((r) =>
        isMatch(r.name, r.artists[0]?.name || "", trackName, artistName) &&
        isDurationMatch(r.duration_ms, durationMs)
      );
      if (match) {
        return {
          videoId: match.videoId,
          source: "jiosaavn",
          image: yt?.thumbnail || match.image,
          durationMs: Number.isFinite(match.duration_ms) ? match.duration_ms : 0,
        };
      }
      if (yt) {
        return { videoId: yt.videoId, source: "youtube", image: yt.thumbnail, durationMs: Number.isFinite(yt.durationMs) ? yt.durationMs : 0 };
      }
    } catch (err) {
      console.error("JioSaavn search failed:", err);
    }
    return { videoId: "", source: "", image: "", durationMs: 0 };
  })();
  return Promise.race([resolve, timeout]);
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
        image: (s.image || "").replace("150x150", "500x500").replace("50x50", "500x500").replace("1080x1080", "500x500"),
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

// POST /api/playlists/import — Import a YouTube, Spotify, JioSaavn, or Apple Music playlist, returning resolved tracks directly (no DB save)
playlistsRoute.post("/import", async (c) => {
  const { url } = await c.req.json();
  if (!url?.trim()) return c.json({ error: "Playlist link is required" }, 400);

  const isYouTube = url.includes("youtube.com") || url.includes("youtu.be");
  const isSpotify = url.includes("spotify.com");
  const isJioSaavn = url.includes("jiosaavn.com");
  const isAppleMusic = url.includes("music.apple.com");

  if (!isYouTube && !isSpotify && !isJioSaavn && !isAppleMusic) {
    return c.json({ error: "Invalid playlist URL. Please provide a YouTube, Spotify, JioSaavn, or Apple Music link." }, 400);
  }

    async function resolveChunked(
    items: { trackName: string; artistName: string; image?: string; durationMs?: number }[],
    chunkSize: number
  ) {
    const resolved: any[] = [];
    const chunks = chunkArray(items, chunkSize);
    for (const chunk of chunks) {
      const results = await Promise.all(
        chunk.map(async (item) => {
          const r = await resolveTrackToJioSaavn(item.trackName, item.artistName, item.durationMs);
          if (r.videoId) {
            return {
              videoId: r.videoId,
              source: r.source,
              trackName: item.trackName,
              artistName: item.artistName,
              image: item.image || r.image || "",
              durationMs: r.durationMs || item.durationMs || 0,
            };
          }
          return null;
        })
      );
      for (const r of results) {
        if (r) resolved.push(r);
      }
    }
    return resolved;
  }

  try {
    let name = "Imported Playlist";
    let tracks: any[] = [];

    if (isYouTube) {
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
      name = scraped.name;
      tracks = await resolveChunked(
        scraped.tracks.map((t: any) => ({ trackName: t.title, artistName: t.artist })),
        5
      );
    } else if (isJioSaavn) {
      const scraped = await getJioSaavnPlaylistTracks(url);
      if (!scraped || scraped.tracks.length === 0) {
        return c.json({ error: "Failed to fetch JioSaavn playlist. Ensure the playlist is public." }, 404);
      }
      name = scraped.name;
      tracks = scraped.tracks.map((t: any) => ({
        videoId: t.id,
        source: "jiosaavn",
        trackName: t.title,
        artistName: t.artists,
        image: t.image || "",
        durationMs: (t.duration || 0) * 1000,
      }));
    } else if (isAppleMusic) {
      const scraped = await getAppleMusicPlaylistTracks(url);
      if (!scraped || scraped.tracks.length === 0) {
        return c.json({ error: "Failed to fetch Apple Music playlist. Ensure the playlist is public." }, 404);
      }
      name = scraped.name;
      tracks = await resolveChunked(
        scraped.tracks.map((t: any) => ({ trackName: t.trackName, artistName: t.artistName, image: t.image, durationMs: t.durationMs })),
        5
      );
    } else {
      // Spotify (playlist or album)
      const spotifyRegex = /\/(playlist|album)\/([a-zA-Z0-9]+)/;
      const sm = url.match(spotifyRegex);
      const spotifyType = sm ? sm[1] : null;
      const spotifyId = sm ? sm[2] : null;
      if (!spotifyType || !spotifyId) return c.json({ error: "Could not parse Spotify playlist/album ID from URL" }, 400);

      let tracksToResolve: { trackName: string; artistName: string; image?: string; durationMs?: number }[] = [];
      let fetchedSuccessfully = false;

      const clientId = process.env.SPOTIFY_CLIENT_ID;
      const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

      if (clientId && clientSecret) {
        try {
          const accessToken = await getSpotifyAccessToken(clientId, clientSecret);
          if (accessToken) {
            const spotifyRes = await fetch(`https://api.spotify.com/v1/${spotifyType}s/${spotifyId}`, {
              headers: { Authorization: `Bearer ${accessToken}` },
            });
            if (spotifyRes.ok) {
              const pd = await spotifyRes.json();
              name = pd.name || "Imported Spotify Playlist";
              const rawItems = spotifyType === "album"
                ? (pd.tracks?.items || [])
                : (pd.tracks?.items || []);
              tracksToResolve = rawItems.map((item: any) => ({
                trackName: item?.name || item?.track?.name || "Unknown Track",
                artistName: item?.artists?.map((a: any) => a.name).join(", ") || item?.track?.artists?.map((a: any) => a.name).join(", ") || "Unknown Artist",
                image: item?.images?.[0]?.url || item?.track?.album?.images?.[0]?.url || "",
                durationMs: item?.duration_ms || item?.track?.duration_ms || 0,
              }));
              fetchedSuccessfully = true;
            }
          }
        } catch (err) {
          console.error("Spotify API failed, falling back:", err);
        }
      }

      if (!fetchedSuccessfully) {
        const scraped = await getSpotifyTracksViaEmbed(spotifyType, spotifyId);
        if (scraped) {
          name = scraped.name;
          tracksToResolve = scraped.tracks;
          fetchedSuccessfully = true;
        }
      }

      if (!fetchedSuccessfully) {
        return c.json({ error: "Failed to fetch Spotify playlist/album. Ensure it is public." }, 404);
      }

      tracks = await resolveChunked(tracksToResolve, 2);
    }

    return c.json({ name, tracks });
  } catch (err) {
    console.error("Playlist import failed:", err);
    return c.json({ error: "Playlist import failed" }, 500);
  }
});

export default playlistsRoute;
