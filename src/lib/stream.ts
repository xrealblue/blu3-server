import { exec } from "node:child_process";
import { promisify } from "node:util";
import { unifiedGet, unifiedSet, unifiedDel } from "./redis.js";

const execAsync = promisify(exec);

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
    const { stdout } = await execAsync(
      `yt-dlp -g -f "bestaudio" --no-warnings ${videoId}`,
      { encoding: "utf8", timeout: 10000, windowsHide: true },
    );
    return stdout?.trim() || null;
  } catch {
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
