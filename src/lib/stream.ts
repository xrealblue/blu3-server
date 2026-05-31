import ytdl from "@distube/ytdl-core";
import { unifiedGet, unifiedSet, unifiedDel } from "./redis.js";
import { readFileSync, existsSync } from "node:fs";

/* ─── Cookies agent for ytdl-core ────────────────────── */
function loadCookiesAgent(): ytdl.Agent | undefined {
  try {
    const raw = process.env.YT_COOKIES;
    if (raw) {
      const cookies = JSON.parse(raw);
      return ytdl.createAgent(cookies);
    }
    const file = process.env.YT_COOKIES_FILE;
    if (file && existsSync(file)) {
      const cookies = JSON.parse(readFileSync(file, "utf-8"));
      return ytdl.createAgent(cookies);
    }
  } catch (err) {
    console.error("Failed to load cookies:", err);
  }
}

const cookiesAgent = loadCookiesAgent();

/* ─── Stream URL cache via Redis + in-memory ─────────── */
const CACHE_PREFIX = "stream:";
const pending = new Map<string, Promise<string | null>>();

async function getCached(videoId: string): Promise<string | null> {
  return unifiedGet<string>(`${CACHE_PREFIX}${videoId}`);
}

async function setCache(videoId: string, url: string): Promise<void> {
  const parsed = parseExpire(url);
  const ttlSeconds = parsed
    ? Math.max(Math.floor((parsed - Date.now()) / 1000) - 300, 60)
    : 14400;
  await unifiedSet(`${CACHE_PREFIX}${videoId}`, url, ttlSeconds);
}

export async function invalidateCache(videoId: string): Promise<void> {
  await unifiedDel(`${CACHE_PREFIX}${videoId}`);
}

function parseExpire(url: string): number | null {
  const match = url.match(/[?&]expire=(\d+)/);
  if (!match) return null;
  return Number(match[1]) * 1000;
}

/* ─── yt-dlp extractor ───────────────────────────────── */

async function extractWithYtdlp(videoId: string): Promise<string | null> {
  try {
    const info = await ytdl.getInfo(videoId, {
      requestOptions: {
        headers: { "User-Agent": "Mozilla/5.0" },
      },
      agent: cookiesAgent,
    });

    try {
      return ytdl.chooseFormat(info.formats, { quality: "lowestaudio" }).url;
    } catch {}

    const audio = ytdl.filterFormats(info.formats, "audioonly");
    if (audio.length > 0) return audio[0].url;

    const anyAudio = info.formats.find(
      (f) => f.mimeType?.startsWith("audio/") && f.url,
    );
    if (anyAudio) return anyAudio.url;

    return null;
  } catch (err) {
    console.error("yt-dlp extraction failed:", (err as Error)?.message ?? err);
    return null;
  }
}

/* ─── Public API ─────────────────────────────────────── */

async function doExtract(videoId: string): Promise<string | null> {
  const existing = pending.get(videoId);
  if (existing) return existing;

  const promise = extractWithYtdlp(videoId)
    .then((url) => {
      if (url) setCache(videoId, url).catch(() => {});
      return url;
    })
    .finally(() => {
      pending.delete(videoId);
    });

  pending.set(videoId, promise);
  return promise;
}

export async function getAudioStreamUrl(
  videoId: string,
): Promise<string | null> {
  const cached = await getCached(videoId);
  if (cached) return cached;

  return doExtract(videoId);
}

export async function preloadStream(videoId: string): Promise<void> {
  const cached = await getCached(videoId);
  if (cached) return;
  if (pending.has(videoId)) return;

  doExtract(videoId).catch(() => {});
}
