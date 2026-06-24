import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ── youtubei.js ──

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

export interface YouTubeMusicSearchResult {
  videoId: string;
  name: string;
  artist: string;
  thumbnail: string;
  durationMs: number;
}

export async function searchYouTube(query: string): Promise<string | null> {
  try {
    const yt = await getInnertube();
    const results = await yt.music.search(query, { type: "song" });
    const songs = results?.songs?.contents || [];
    return songs[0]?.id || songs[0]?.videoId || null;
  } catch (err) {
    console.error(`[ytAudio] searchYouTube("${query}") failed:`, err);
    return null;
  }
}

export async function searchYouTubeWithMetadata(query: string): Promise<YouTubeSearchResult | null> {
  try {
    const yt = await getInnertube();
    const results = await yt.music.search(query, { type: "song" });
    const songs = results?.songs?.contents || [];
    if (!songs[0]) return null;
    const s = songs[0];
    const thumbs = s.thumbnail?.contents || [];
    const bestThumb = thumbs.find((t: any) => t.width >= 200) || thumbs[0];
    return {
      videoId: s.id || s.videoId,
      thumbnail: bestThumb?.url || `https://i.ytimg.com/vi/${s.id}/hqdefault.jpg`,
      durationMs: Number.isFinite(Number(s.duration)) ? Number(s.duration) * 1000 : 0,
    };
  } catch (err) {
    console.error(`[ytAudio] searchYouTubeWithMetadata("${query}") failed:`, err);
    return null;
  }
}

export async function searchYouTubeResults(query: string): Promise<YouTubeMusicSearchResult[]> {
  try {
    const yt = await getInnertube();
    const results = await yt.music.search(query, { type: "song" });
    const songs = results?.songs?.contents || [];
    return songs.slice(0, 10).map((s: any) => {
      const thumbs = s.thumbnail?.contents || [];
      const bestThumb = thumbs.find((t: any) => t.width >= 200) || thumbs[0];
      return {
        videoId: s.id || s.videoId,
        name: s.name || s.title || "",
        artist: s.artists?.[0]?.name || s.author?.name || "",
        thumbnail: bestThumb?.url || "",
        durationMs: Number.isFinite(Number(s.duration)) ? Number(s.duration) * 1000 : 0,
      };
    });
  } catch (err) {
    console.error(`[ytAudio] searchYouTubeResults("${query}") failed:`, err);
    return [];
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
