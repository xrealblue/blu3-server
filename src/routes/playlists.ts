import { Hono, type MiddlewareHandler } from "hono";
import { db } from "../db/index.js";
import { playlists, playlistTracks, users } from "../db/schema.js";
import { eq, and, desc, asc } from "drizzle-orm";
import { verify } from "hono/jwt";
import type YTMusic from "ytmusic-api";
import { getYTMusic } from "../lib/ytmusic.js";

type PlaylistsEnv = {
  Variables: {
    userId: string;
  };
};

const playlistsRoute = new Hono<PlaylistsEnv>();

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
    const jsUri = html.match(/\/assets\/index-legacy-[^/]+\.js/)?.[0];
    if (!jsUri) return null;

    const jsRes = await fetch(`https://beta.music.apple.com${jsUri}`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    if (!jsRes.ok) return null;
    const js = await jsRes.text();
    const token = js.match(/eyJ[a-zA-Z0-9_-]+?\.[a-zA-Z0-9_-]+?\.[a-zA-Z0-9_-]+/)?.[0];
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

    const apiUrl = `https://amp-api.music.apple.com/v1/catalog/${parts.storefront}/playlists/${parts.playlistId}?include=tracks`;
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

    const playlistName = playlist.attributes?.name || "Imported Apple Music Playlist";
    const tracksData = playlist.relationships?.tracks?.data || [];

    const tracks: ScrapedSpotifyTrack[] = tracksData
      .filter((item: any) => item.type === "songs")
      .map((item: any) => ({
        trackName: item.attributes?.name || "Unknown Track",
        artistName: item.attributes?.artistName || "Unknown Artist",
      }));

    if (tracks.length === 0) return null;

    return { name: playlistName, tracks };
  } catch (err) {
    console.error("Apple Music scrape failed:", err);
    return null;
  }
}

// Resolves a track details by name + artist to a playable YouTube video details object (official YTMusic preferred, YouTube fallback)
async function resolveTrackToOfficialYouTube(
  trackName: string,
  artistName: string,
  fallbackVideoId: string,
  fallbackImage: string,
  fallbackDurationMs: number,
  ytmusic: YTMusic
): Promise<{ videoId: string; image: string; durationMs: number }> {
  const query = `${trackName} ${artistName !== "Unknown Artist" ? artistName : ""}`.trim();
  const apiKey = process.env.YOUTUBE_API_KEY;

  // 1. Prioritize ytmusic-api to get high quality square track/album art
  try {
    const results = await ytmusic.searchSongs(query);
    const song = results[0];
    if (song && song.videoId) {
      // Loose validation check to prevent matching a wrong/unrelated song if missing in YTMusic
      const cleanStr = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
      const cleanExpectedTitle = cleanStr(trackName);
      const cleanActualTitle = cleanStr(song.name);
      const cleanExpectedArtist = cleanStr(artistName);
      const cleanActualArtist = cleanStr(song.artist?.name || "");

      // Match if the actual title contains the expected title, or vice-versa
      const titleMatches = cleanActualTitle.includes(cleanExpectedTitle) || cleanExpectedTitle.includes(cleanActualTitle);
      
      // Alternatively, match if the first two words of expected title match
      const expectedWords = cleanExpectedTitle.split(" ");
      const firstTwoWords = expectedWords.slice(0, 2).join(" ");
      const partialTitleMatches = firstTwoWords.length > 2 && cleanActualTitle.includes(firstTwoWords);

      // Check artist matching if an artist is expected (not unknown)
      const hasArtist = cleanExpectedArtist && cleanExpectedArtist !== "unknown artist";
      const artistMatches = !hasArtist || 
                            cleanActualArtist.includes(cleanExpectedArtist) || 
                            cleanExpectedArtist.includes(cleanActualArtist) ||
                            cleanExpectedArtist.split(" ").some(word => word.length > 2 && cleanActualArtist.includes(word));

      if ((titleMatches || partialTitleMatches) && artistMatches) {
        const thumbs = song.thumbnails ?? [];
        const rawThumb = thumbs[thumbs.length - 1]?.url ?? "";
        // Premium square album artwork resolution from YouTube Music
        const image = rawThumb ? rawThumb.replace(/=w\d+-h\d+.*$/, "=w226-h226-l90-rj") : "";
        return {
          videoId: song.videoId,
          image: image || fallbackImage,
          durationMs: (song.duration ?? 0) * 1000 || fallbackDurationMs || 180000,
        };
      } else {
        console.warn(`[YTMusic Check Failed] "${trackName}" by "${artistName}" returned mismatched song: "${song.name}" by "${song.artist?.name}". Falling back to YouTube.`);
      }
    }
  } catch (err) {
    console.error("ytmusic-api search failed, trying YouTube API:", err);
  }

  // 2. If no official track exists, but we have a fallback video/image, use that!
  if (fallbackVideoId) {
    return {
      videoId: fallbackVideoId,
      image: fallbackImage,
      durationMs: fallbackDurationMs,
    };
  }

  // 3. Fallback to regular YouTube Search API if ytmusic fails and no fallback is provided
  if (apiKey) {
    try {
      const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&key=${apiKey}&maxResults=1`;
      const searchRes = await fetch(searchUrl);
      const searchData = await searchRes.json();
      const videoItem = searchData.items?.[0];

      if (videoItem) {
        const videoId = videoItem.id.videoId;
        const image = videoItem.snippet.thumbnails?.high?.url || videoItem.snippet.thumbnails?.default?.url || "";

        const detailsUrl = `https://www.googleapis.com/youtube/v3/videos?part=contentDetails&id=${videoId}&key=${apiKey}`;
        const detailsRes = await fetch(detailsUrl);
        const detailsData = await detailsRes.json();
        const durationStr = detailsData.items?.[0]?.contentDetails?.duration;

        let durationMs = 180000;
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

    // Enrich each playlist with coverImage (first track image) and trackCount
    const enriched = await Promise.all(
      userPlaylists.map(async (pl) => {
        const tracks = await db
          .select({ image: playlistTracks.image })
          .from(playlistTracks)
          .where(eq(playlistTracks.playlistId, pl.id))
          .orderBy(asc(playlistTracks.position));

        const coverImage = tracks.find((t) => t.image)?.image || "";
        return {
          ...pl,
          coverImage,
          trackCount: tracks.length,
        };
      })
    );

    return c.json({ playlists: enriched });
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

// POST /api/playlists/import — Import a Spotify, YouTube Music, or Apple Music playlist link
playlistsRoute.post("/import", async (c) => {
  const userId = c.get("userId");
  const { url } = await c.req.json();
  if (!url?.trim()) return c.json({ error: "Playlist link is required" }, 400);

  const isSpotify = url.includes("spotify.com");
  const isYouTube = url.includes("youtube.com") || url.includes("youtu.be");
  const isAppleMusic = url.includes("music.apple.com");

  if (!isSpotify && !isYouTube && !isAppleMusic) {
    return c.json({ error: "Invalid playlist URL. Please provide a Spotify, YouTube Music, or Apple Music link." }, 400);
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
        const chunks = chunkArray(rawVideos, 5);
        let positionCounter = 0;
        const tracksToInsert: any[] = [];

        for (const chunk of chunks) {
          const resolvedList = await Promise.all(
            chunk.map(async (video) => {
              const thumbs = video.thumbnails ?? [];
              const rawThumb = thumbs[thumbs.length - 1]?.url ?? "";
              const fallbackImage = rawThumb ? rawThumb.replace(/=w\d+-h\d+.*$/, "=w226-h226-l90-rj") : "";
              const fallbackVideoId = video.videoId;
              const fallbackDurationMs = (video.duration ?? 0) * 1000 || 180000;
              const artistName = video.artist?.name || "Unknown Artist";

              // Resolve to see if a cool official YouTube Music track exists!
              const resolved = await resolveTrackToOfficialYouTube(
                video.name,
                artistName,
                fallbackVideoId,
                fallbackImage,
                fallbackDurationMs,
                ytmusic
              );

              return {
                playlistId: newPlaylist.id,
                videoId: resolved.videoId,
                trackName: video.name,
                artistName,
                image: resolved.image,
                durationMs: resolved.durationMs,
              };
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
      }

      return c.json({ playlist: newPlaylist, trackCount: rawVideos.length });
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
            const resolved = await resolveTrackToOfficialYouTube(
              item.trackName, item.artistName, "", "", 0, ytmusic
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

            const resolved = await resolveTrackToOfficialYouTube(trackName, artistName, "", "", 0, ytmusic);
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
