import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { default: YTDlpWrap } = require("yt-dlp-wrap") as {
  default: new (binaryPath?: string) => {
    getVideoInfo(ytDlpArguments: string | string[]): Promise<any>;
    execStream(ytDlpArguments?: string[]): any;
  };
};

const ytDlpWrap = new YTDlpWrap();

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

export async function extractAudioUrl(videoId: string): Promise<string> {
  const cached = getCachedAudioUrl(videoId);
  if (cached) return cached;

  const info = await ytDlpWrap.getVideoInfo(
    `https://www.youtube.com/watch?v=${videoId}`,
  );
  const url = info.url;
  if (!url) throw new Error("No audio URL in yt-dlp response");

  audioUrlCache.set(videoId, { url, fetchedAt: Date.now() });
  return url;
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

async function ytSearchWithTimeout(query: string, timeoutMs = 10000): Promise<any> {
  const promise = ytDlpWrap.getVideoInfo(`ytsearch:${query}`);
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("yt-dlp search timed out")), timeoutMs),
  );
  return Promise.race([promise, timeout]);
}

export async function searchYouTube(query: string): Promise<string | null> {
  try {
    const info = await ytSearchWithTimeout(query);
    return info?.id || null;
  } catch (err) {
    console.error(`[ytAudio] searchYouTube("${query}") failed:`, err);
    return null;
  }
}

export async function searchYouTubeWithMetadata(query: string): Promise<YouTubeSearchResult | null> {
  try {
    const info = await ytSearchWithTimeout(query);
    if (!info?.id) {
      console.error(`[ytAudio] searchYouTubeWithMetadata("${query}") returned no id`);
      return null;
    }
    return {
      videoId: info.id,
      thumbnail: info.thumbnail || `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`,
      durationMs: (info.duration || 0) * 1000,
    };
  } catch (err) {
    console.error(`[ytAudio] searchYouTubeWithMetadata("${query}") failed:`, err);
    return null;
  }
}
