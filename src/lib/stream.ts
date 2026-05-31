import { Innertube } from "youtubei.js";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

let innertube: Innertube | null = null;

/* ─── Stream URL cache ─────────────────────────────────────────────── */

interface CacheEntry {
  url: string;
  expiresAt: number;
}

const streamCache = new Map<string, CacheEntry>();
const CACHE_PURGE_INTERVAL = 10 * 60 * 1000; // 10 min

function parseExpire(url: string): number | null {
  const match = url.match(/[?&]expire=(\d+)/);
  if (!match) return null;
  return Number(match[1]) * 1000; // seconds → ms
}

function getCached(videoId: string): string | null {
  const entry = streamCache.get(videoId);
  if (!entry) return null;
  // keep 5-min safety margin before YouTube's expiry
  if (Date.now() >= entry.expiresAt - 300_000) {
    streamCache.delete(videoId);
    return null;
  }
  return entry.url;
}

function setCache(videoId: string, url: string): void {
  const parsed = parseExpire(url);
  const expiresAt = parsed ?? Date.now() + 4 * 60 * 60 * 1000; // 4h default
  streamCache.set(videoId, { url, expiresAt });
}

// periodic eviction of stale entries
let purgeTimer: ReturnType<typeof setInterval> | null = null;
function ensurePurgeTimer(): void {
  if (purgeTimer) return;
  purgeTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of streamCache) {
      if (now >= entry.expiresAt - 300_000) streamCache.delete(id);
    }
    if (streamCache.size === 0 && purgeTimer) {
      clearInterval(purgeTimer);
      purgeTimer = null;
    }
  }, CACHE_PURGE_INTERVAL);
  purgeTimer.unref?.();
}

/* ─── Cookie helpers ───────────────────────────────────────────────── */

function getCookieHeader(): string {
  if (process.env.YT_COOKIES) return process.env.YT_COOKIES;
  const jsonPath = resolve(
    process.cwd(),
    process.env.YT_COOKIES_FILE ?? "cookies.json",
  );
  if (!existsSync(jsonPath)) return "";
  try {
    const raw = readFileSync(jsonPath, "utf8");
    const cookies: { name: string; value: string }[] = JSON.parse(raw);
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return "";
  }
}

/* ─── Extractors ───────────────────────────────────────────────────── */

async function getInnertube(): Promise<Innertube> {
  if (innertube) return innertube;
  innertube = await Innertube.create({
    cookie: getCookieHeader(),
  });
  return innertube;
}

async function extractWithYoutubei(videoId: string): Promise<string | null> {
  try {
    const yt = await getInnertube();
    const info = await yt.getInfo(videoId);
    const format = info.chooseFormat({ type: "audio", quality: "best" });
    if (format && format.url) return format.url;
    const formats = info.streaming_data?.adaptive_formats ?? [];
    const audioFormats = formats.filter(
      (f: any) => f.has_audio && !f.has_video,
    );
    audioFormats.sort((a: any, b: any) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
    for (const f of audioFormats) {
      if (f.url) return f.url;
    }
    return null;
  } catch {
    return null;
  }
}

function extractWithYtdlp(videoId: string): string | null {
  try {
    const url = execSync(
      `yt-dlp -g -f "bestaudio[ext=m4a]/bestaudio" --no-warnings ${videoId}`,
      { encoding: "utf8", timeout: 20000, windowsHide: true },
    ).trim();
    return url || null;
  } catch {
    return null;
  }
}

/* ─── Public API ───────────────────────────────────────────────────── */

export async function getAudioStreamUrl(
  videoId: string,
): Promise<string | null> {
  // 1. check cache
  const cached = getCached(videoId);
  if (cached) return cached;

  // 2. extract
  const fromDlp = extractWithYtdlp(videoId);
  if (fromDlp) {
    setCache(videoId, fromDlp);
    ensurePurgeTimer();
    return fromDlp;
  }
  const fromYt = await extractWithYoutubei(videoId);
  if (fromYt) {
    setCache(videoId, fromYt);
    ensurePurgeTimer();
  }
  return fromYt;
}

/** Pre-extract a stream URL and warm the cache (call from ws handler) */
export async function preloadStream(videoId: string): Promise<void> {
  if (getCached(videoId)) return; // already cached
  await getAudioStreamUrl(videoId);
}
