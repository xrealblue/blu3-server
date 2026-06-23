import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { default: YTDlpWrap } = require("yt-dlp-wrap") as {
  default: new (binaryPath?: string) => {
    getVideoInfo(ytDlpArguments: string | string[]): Promise<any>;
    execPromise(ytDlpArguments: string[], options?: any, abortSignal?: AbortSignal): Promise<string>;
    execStream(ytDlpArguments?: string[]): any;
  };
};
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

const ytDlpWrap = new YTDlpWrap();
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

const INVidIOUS_INSTANCES = [
  "https://inv.nadeko.net",
  "https://yewtu.be",
  "https://invidious.flokinet.to",
  "https://vid.puffyan.us",
];

async function fetchAudioUrlFromInvidious(videoId: string): Promise<string | null> {
  for (const instance of INVidIOUS_INSTANCES) {
    try {
      const res = await fetch(`${instance}/api/v1/videos/${videoId}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const data: any = await res.json();
      const formats: any[] = data.adaptiveFormats || [];
      const audio = formats
        .filter((f: any) => (f.type || f.mimeType || "").startsWith("audio"))
        .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0));
      if (audio.length > 0) return audio[0].url;
    } catch {}
  }
  return null;
}

export async function extractAudioUrl(videoId: string): Promise<string> {
  const cached = getCachedAudioUrl(videoId);
  if (cached) return cached;

  const ytDlpPromise = (async () => {
    const args = [
      `https://www.youtube.com/watch?v=${videoId}`,
      "-f", "bestaudio",
      "--dump-json",
    ];
    const stdout = await ytDlpWrap.execPromise(args, undefined, AbortSignal.timeout(20000));
    const info = JSON.parse(stdout);
    if (!info.url) throw new Error("No audio URL in yt-dlp response");
    return info.url;
  })();

  const invidiousPromise = (async () => {
    return fetchAudioUrlFromInvidious(videoId);
  })();

  const url = await Promise.any([ytDlpPromise, invidiousPromise])
    .catch(() => { throw new Error(`Failed to extract audio URL for ${videoId}`); });

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
