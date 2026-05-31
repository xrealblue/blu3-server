import { Innertube } from "youtubei.js";
import { exec } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { unifiedGet, unifiedSet, unifiedDel } from "./redis.js";

const execAsync = promisify(exec);

let innertube: Innertube | null = null;

/* ─── Stream URL cache via Redis + in-memory ─────────── */
const CACHE_PREFIX = "stream:";

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

/* ─── Cookie helpers ─────────────────────────────────── */

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

/* ─── Extractors ─────────────────────────────────────── */

async function getInnertube(timeoutMs = 15_000): Promise<Innertube | null> {
  if (innertube) return innertube;
  try {
    innertube = await Promise.race([
      Innertube.create({ cookie: getCookieHeader() }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Innertube create timeout")), timeoutMs),
      ),
    ]);
  } catch {
    return null;
  }
  return innertube;
}

async function extractWithYoutubei(videoId: string): Promise<string | null> {
  try {
    const yt = await getInnertube();
    if (!yt) return null;
    const info = await yt.getInfo(videoId);
    const format = info.chooseFormat({ type: "audio", quality: "best" });
    if (format?.url) return format.url;
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

async function extractWithYtdlp(videoId: string): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      `yt-dlp -g -f "bestaudio[abr<=64][ext=m4a]/bestaudio[abr<=64]/bestaudio[ext=m4a]" --no-warnings ${videoId}`,
      { encoding: "utf8", timeout: 15000, windowsHide: true },
    );
    return stdout?.trim() || null;
  } catch {
    return null;
  }
}

/* ─── Public API ─────────────────────────────────────── */

export async function getAudioStreamUrl(
  videoId: string,
): Promise<string | null> {
  const cached = await getCached(videoId);
  if (cached) return cached;

  const fromYt = await extractWithYoutubei(videoId);
  if (fromYt) {
    await setCache(videoId, fromYt);
    return fromYt;
  }

  const fromDlp = await extractWithYtdlp(videoId);
  if (fromDlp) {
    await setCache(videoId, fromDlp);
    return fromDlp;
  }

  return null;
}

export async function preloadStream(videoId: string): Promise<void> {
  const cached = await getCached(videoId);
  if (cached) return;
  await getAudioStreamUrl(videoId);
}
