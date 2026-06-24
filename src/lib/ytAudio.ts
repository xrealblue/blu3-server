import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ── ytmusic-api (legacy, kept for compatibility) ──

const YTMusic = require("ytmusic-api") as new () => {
  initialize(opts?: { cookies?: string; GL?: string; HL?: string }): Promise<any>;
  searchSongs(query: string): Promise<{
    videoId: string;
    name: string;
    artist: { name: string };
    duration: number | null;
    thumbnails: { url: string; width: number; height: number }[];
  }[]>;
};

const ytMusicApi = new YTMusic();
let ytMusicInitialized = false;

async function ensureYtMusic() {
  if (!ytMusicInitialized) {
    await ytMusicApi.initialize({ GL: "US", HL: "en" });
    ytMusicInitialized = true;
  }
}

// ── youtubei.js (album art) ──

let innertubeInstance: any = null;
async function getInnertube() {
  if (!innertubeInstance) {
    const { Innertube } = require("youtubei.js");
    innertubeInstance = await Innertube.create({ generate_session_locally: true });
  }
  return innertubeInstance;
}

export interface YouTubeSearchResult {
  videoId: string;
  thumbnail: string;
  durationMs: number;
}

export async function searchYouTube(query: string): Promise<string | null> {
  try {
    await ensureYtMusic();
    const results = await ytMusicApi.searchSongs(query);
    return results[0]?.videoId || null;
  } catch (err) {
    console.error(`[ytAudio] searchYouTube("${query}") failed:`, err);
    return null;
  }
}

export async function searchYouTubeWithMetadata(query: string): Promise<YouTubeSearchResult | null> {
  try {
    try {
      const yt = await getInnertube();
      const results = await yt.music.search(query, { type: "song" });
      const songs = results?.songs?.contents || [];
      if (songs[0]) {
        const s = songs[0];
        const thumbs = s.thumbnail?.contents || [];
        const bestThumb = thumbs.find((t: any) => t.width >= 200) || thumbs[0];
        return {
          videoId: s.id || s.videoId,
          thumbnail: bestThumb?.url || `https://i.ytimg.com/vi/${s.id}/hqdefault.jpg`,
          durationMs: (s.duration || 0) * 1000,
        };
      }
    } catch {}
    await ensureYtMusic();
    const results = await ytMusicApi.searchSongs(query);
    if (!results[0]?.videoId) return null;
    const hit = results[0];
    return {
      videoId: hit.videoId,
      thumbnail: `https://i.ytimg.com/vi/${hit.videoId}/hqdefault.jpg`,
      durationMs: (hit.duration || 0) * 1000,
    };
  } catch (err) {
    console.error(`[ytAudio] searchYouTubeWithMetadata("${query}") failed:`, err);
    return null;
  }
}

export async function getYoutubeMusicAlbumArt(name: string, artist?: string): Promise<string | null> {
  try {
    const yt = await getInnertube();
    const query = artist ? `${name} ${artist}` : name;
    const results = await yt.music.search(query, { type: "song" });
    const songs = results?.songs?.contents || [];
    if (!songs[0]) return null;
    const thumbs = songs[0].thumbnail?.contents || [];
    const bestThumb = thumbs.find((t: any) => t.width >= 200) || thumbs[0];
    return bestThumb?.url || null;
  } catch (err) {
    console.error(`[ytAudio] getYoutubeMusicAlbumArt failed:`, err);
    return null;
  }
}
