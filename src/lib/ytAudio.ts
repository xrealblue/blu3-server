import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
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

const audioUrlCache = new Map<string, { url: string; fetchedAt: number }>();
const CACHE_TTL = 6 * 60 * 60 * 1000;

setInterval(() => {
  const cutoff = Date.now() - CACHE_TTL;
  for (const [key, entry] of audioUrlCache) {
    if (entry.fetchedAt < cutoff) audioUrlCache.delete(key);
  }
}, 30 * 60 * 1000);

export function getCachedAudioUrl(videoId: string): string | null {
  const entry = audioUrlCache.get(videoId);
  if (entry && Date.now() - entry.fetchedAt < CACHE_TTL) {
    return entry.url;
  }
  return null;
}

async function tryInnerTube(videoId: string): Promise<string | null> {
  try {
    const res = await fetch(
      "https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "com.google.android.youtube/19.30.36 (Linux; U; Android 14; en_US) gzip",
          "X-YouTube-Client-Name": "3",
          "X-YouTube-Client-Version": "19.30.36",
        },
        body: JSON.stringify({
          videoId,
          context: {
            client: {
              clientName: "ANDROID",
              clientVersion: "19.30.36",
              androidSdkVersion: 34,
              osName: "Android",
              osVersion: "14",
              platform: "MOBILE",
              hl: "en",
              gl: "US",
              timeZone: "UTC",
              utcOffsetMinutes: 0,
            },
          },
          contentCheckOk: true,
          racyCheckOk: true,
        }),
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!res.ok) return null;
    const data: any = await res.json();
    if (data?.playabilityStatus?.status !== "OK") return null;
    const formats: any[] = data?.streamingData?.adaptiveFormats ?? [];
    const audio = formats
      .filter((f: any) => (f.mimeType || "").startsWith("audio/"))
      .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0));
    return audio[0]?.url || null;
  } catch {
    return null;
  }
}

export async function extractAudioUrl(videoId: string): Promise<string> {
  const cached = getCachedAudioUrl(videoId);
  if (cached) return cached;
  const url = await tryInnerTube(videoId);
  if (url) {
    audioUrlCache.set(videoId, { url, fetchedAt: Date.now() });
    return url;
  }
  throw new Error(`Failed to extract audio URL for ${videoId}`);
}

export async function getStream(videoId: string, rangeHeader?: string): Promise<Response> {
  const url = await extractAudioUrl(videoId);
  const headers: Record<string, string> = {};
  if (rangeHeader) headers["Range"] = rangeHeader;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers });
  if (!res.ok && res.status !== 206) throw new Error("Failed to fetch audio stream");
  return res;
}

export interface YouTubeSearchResult {
  videoId: string;
  thumbnail: string;
  durationMs: number;
}

async function ensureYtMusic() {
  if (!ytMusicInitialized) {
    await ytMusicApi.initialize({ GL: "US", HL: "en" });
    ytMusicInitialized = true;
  }
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
