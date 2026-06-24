import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { default: YTDlpWrap } = require("yt-dlp-wrap") as {
  default: new (binaryPath?: string) => {
    execPromise(ytDlpArguments: string[], options?: any, abortSignal?: AbortSignal): Promise<string>;
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

const COOKIES_PATH = process.env.YOUTUBE_COOKIES_PATH || "./cookies.txt";

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

const BINARY_PATH = process.env.YT_AUDIO_EXTRACTOR_PATH || "./yt-audio-extractor/target/release/yt-audio-extractor";

async function tryYtAudioExtractor(videoId: string): Promise<string | null> {
  if (!existsSync(BINARY_PATH)) return null;
  try {
    const args = ["--video-id", videoId];
    if (existsSync(COOKIES_PATH)) args.push("--cookies", COOKIES_PATH);
    const stdout = execFileSync(BINARY_PATH, args, { timeout: 20000, encoding: "utf8" });
    const { url } = JSON.parse(stdout);
    return url || null;
  } catch {
    return null;
  }
}

const INVidIOUS_INSTANCES = [
  "https://inv.nadeko.net/api/v1/videos/",
  "https://yewtu.be/api/v1/videos/",
  "https://invidious.snopyta.org/api/v1/videos/",
  "https://inv.zzls.xyz/api/v1/videos/",
  "https://invidious.xyz/api/v1/videos/",
  "https://invidious.privacydev.net/api/v1/videos/",
];

async function fetchAudioUrlFromInvidious(videoId: string): Promise<string | null> {
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  for (const base of INVidIOUS_INSTANCES) {
    try {
      const res = await fetch(`${base}${videoId}`, {
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": ua },
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

async function tryYtDlpExtract(videoId: string): Promise<string | null> {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const cookiesArg = existsSync(COOKIES_PATH) ? ["--cookies", COOKIES_PATH] : [];
  const strategies = [
    { args: ["--extractor-args", "youtube:player_client=android"] },
    { args: [] },
  ];
  for (const s of strategies) {
    try {
      const args = [videoUrl, "-f", "bestaudio", "--dump-json", ...cookiesArg, ...s.args];
      const stdout = await ytDlpWrap.execPromise(args, undefined, AbortSignal.timeout(20000));
      const info = JSON.parse(stdout);
      if (info.url) return info.url;
    } catch {}
  }
  return null;
}

export async function extractAudioUrl(videoId: string): Promise<string> {
  const cached = getCachedAudioUrl(videoId);
  if (cached) return cached;

  const binaryUrl = await tryYtAudioExtractor(videoId);
  if (binaryUrl) {
    audioUrlCache.set(videoId, { url: binaryUrl, fetchedAt: Date.now() });
    return binaryUrl;
  }

  const ytDlpUrl = await tryYtDlpExtract(videoId);
  if (ytDlpUrl) {
    audioUrlCache.set(videoId, { url: ytDlpUrl, fetchedAt: Date.now() });
    return ytDlpUrl;
  }

  const invidiousUrl = await fetchAudioUrlFromInvidious(videoId);
  if (invidiousUrl) {
    audioUrlCache.set(videoId, { url: invidiousUrl, fetchedAt: Date.now() });
    return invidiousUrl;
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
