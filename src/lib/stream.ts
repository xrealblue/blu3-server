/*
 * ─────────────────────────────────────────────────────────────────────────────
 * OLD: YouTube stream extraction (yt-dlp + @distube/ytdl-core).
 * Kept for later restoration. Replaced by direct YT iframe playback.
 *
 * To restore:
 *   1. Uncomment everything below
 *   2. Restore GET /stream/:id route in index.ts
 *   3. Ensure yt-dlp binary is available (scripts/download-ytdlp.mjs)
 *   4. Restore preloadStream() calls in ws/handler.ts if needed
 * ─────────────────────────────────────────────────────────────────────────────
 */

/*

import { exec } from "node:child_process";
import { promisify } from "node:util";
import ytdl from "@distube/ytdl-core";
import { unifiedGet, unifiedSet, unifiedDel } from "./redis.js";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execAsync = promisify(exec);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const BIN_DIR = join(ROOT, ".bin");
const BIN_NAME = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
const YT_DLP_BIN = existsSync(join(BIN_DIR, BIN_NAME))
  ? join(BIN_DIR, BIN_NAME)
  : "yt-dlp";

let _cookieCount = 0;
let _cookieSource: string | null = null;
let _cookiesJson: any = null;
let _cookiesAgent: ytdl.Agent | undefined;

function loadCookies() {
  try {
    const raw = process.env.YT_COOKIES;
    if (raw) {
      _cookiesJson = JSON.parse(raw);
      _cookieCount = Array.isArray(_cookiesJson) ? _cookiesJson.length : 0;
      _cookieSource = "YT_COOKIES env var";
    } else {
      const file = process.env.YT_COOKIES_FILE;
      if (file && existsSync(file)) {
        _cookiesJson = JSON.parse(readFileSync(file, "utf-8"));
        _cookieCount = Array.isArray(_cookiesJson) ? _cookiesJson.length : 0;
        _cookieSource = `YT_COOKIES_FILE (${file})`;
      }
    }
  } catch (err) {
    console.error("Failed to load cookies:", err);
  }
  if (_cookiesJson) {
    try { _cookiesAgent = ytdl.createAgent(_cookiesJson); } catch {}
  }
}

loadCookies();

async function extractWithYtdlp(videoId: string): Promise<string | null> {
  try {
    const cookiesArg =
      process.env.YT_COOKIES_FILE && existsSync(process.env.YT_COOKIES_FILE)
        ? ` --cookies "${process.env.YT_COOKIES_FILE}"`
        : "";
    const { stdout } = await execAsync(
      `"${YT_DLP_BIN}" -g -f "bestaudio" --no-warnings${cookiesArg} ${videoId}`,
      { encoding: "utf8", timeout: 30000, windowsHide: true },
    );
    return stdout?.trim() || null;
  } catch {
    return null;
  }
}

async function extractWithYtdlCore(videoId: string): Promise<string | null> {
  try {
    const info = await ytdl.getInfo(videoId, {
      requestOptions: { headers: { "User-Agent": "Mozilla/5.0" } },
      agent: _cookiesAgent,
    });

    const strategies = [
      () => ytdl.chooseFormat(info.formats, { quality: "lowestaudio" }),
      () => ytdl.chooseFormat(info.formats, { quality: "highestaudio" }),
      () => ytdl.filterFormats(info.formats, "audioonly")[0],
      () => info.formats.find((f) => f.hasAudio && f.url),
      () => info.formats.find((f) => f.mimeType?.startsWith("audio/") && f.url),
    ];

    for (const fn of strategies) {
      try {
        const f = fn();
        if (f?.url) return f.url;
      } catch {}
    }

    return null;
  } catch {
    return null;
  }
}

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

async function doExtract(videoId: string): Promise<string | null> {
  const existing = pending.get(videoId);
  if (existing) return existing;

  const promise = (async () => {
    let url = await extractWithYtdlp(videoId);
    if (url) {
      setCache(videoId, url).catch(() => {});
      return url;
    }
    url = await extractWithYtdlCore(videoId);
    if (url) setCache(videoId, url).catch(() => {});
    return url;
  })();

  pending.set(videoId, promise.finally(() => pending.delete(videoId)));
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

export function getCookieStatus() {
  return {
    hasAgent: !!_cookiesAgent,
    cookieCount: _cookieCount,
    source: _cookieSource,
    ytCookiesSet: !!process.env.YT_COOKIES,
    ytCookiesFileSet: !!process.env.YT_COOKIES_FILE,
    ytCookiesFileExists: process.env.YT_COOKIES_FILE
      ? existsSync(process.env.YT_COOKIES_FILE)
      : false,
    ytDlpBin: YT_DLP_BIN,
    ytDlpExists: existsSync(YT_DLP_BIN) || YT_DLP_BIN === "yt-dlp",
  };
}

export async function testExtract(videoId: string) {
  const dlpStart = Date.now();
  const dlpUrl = await extractWithYtdlp(videoId);
  const coreStart = Date.now();
  const coreUrl = await extractWithYtdlCore(videoId);

  return {
    cookies: getCookieStatus(),
    extract: {
      ytdlp: {
        ok: !!dlpUrl,
        elapsed: coreStart - dlpStart,
        hasUrl: !!dlpUrl,
      },
      ytdlcore: {
        ok: !!coreUrl,
        elapsed: Date.now() - coreStart,
        hasUrl: !!coreUrl,
      },
    },
  };
}

*/