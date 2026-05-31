import { Innertube } from "youtubei.js";
import { unifiedGet, unifiedSet, unifiedDel } from "./redis.js";
import { readFileSync, existsSync } from "node:fs";

const CACHE_PREFIX = "stream:";
const pending = new Map<string, Promise<string | null>>();

const CLIENTS = ["TV_EMBEDDED", "ANDROID", "TV", "ANDROID_VR", "TV_SIMPLY", "WEB"] as const;

let _innertube: Innertube | null = null;
let _cookieSource: string | null = null;
let _cookieLogin = false;

function parseNetscape(raw: string): string | undefined {
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map((c: any) => `${c.name}=${c.value}`).join("; ");
      }
    } catch {}
  }
  if (!raw.startsWith("#") && raw.includes("=")) {
    return raw;
  }
  const lines = raw.replace(/\r/g, "").split("\n").filter((l) => l.trim());
  const cookies: string[] = [];
  for (const line of lines) {
    const cleaned = line.startsWith("#HttpOnly_") ? line.slice(10) : line;
    if (cleaned.startsWith("#")) continue;
    const parts = cleaned.split("\t");
    if (parts.length >= 7) {
      cookies.push(`${parts[5]}=${parts[6]}`);
    }
  }
  if (cookies.length > 0) return cookies.join("; ");
  return undefined;
}

function loadCookieString(): string | undefined {
  const raw = process.env.YT_COOKIES;
  if (raw) {
    _cookieSource = "YT_COOKIES env var";
    const parsed = parseNetscape(raw);
    if (parsed) return parsed;
    return raw;
  }
  const file = process.env.YT_COOKIES_FILE;
  if (file && existsSync(file)) {
    const content = readFileSync(file, "utf-8").trim();
    _cookieSource = `YT_COOKIES_FILE (${file})`;
    const parsed = parseNetscape(content);
    if (parsed) return parsed;
    return content;
  }
  return undefined;
}

async function getInnertube(): Promise<Innertube> {
  if (_innertube) return _innertube;

  const cookie = loadCookieString();

  const config: Record<string, any> = {};
  if (cookie) {
    config.cookie = cookie;
    _cookieLogin = true;
  }
  if (process.env.YT_VISITOR_DATA) {
    config.visitor_data = process.env.YT_VISITOR_DATA;
  }

  _innertube = await Innertube.create(config);
  return _innertube;
}

export async function invalidateCache(videoId: string): Promise<void> {
  await unifiedDel(`${CACHE_PREFIX}${videoId}`);
}

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

function parseExpire(url: string): number | null {
  const match = url.match(/[?&]expire=(\d+)/);
  if (!match) return null;
  return Number(match[1]) * 1000;
}

async function tryExtract(videoId: string, client: string): Promise<string | null> {
  const yt = await getInnertube();
  const override = client as any;

  let info: any;
  try {
    info = await yt.getBasicInfo(videoId, { client: override });
  } catch (err: any) {
    if (err.info?.status === 'ERROR') {
      console.error(`stream extract: client=${client}: playability_status=ERROR reason="${err.info?.reason}" embeddable=${err.info?.embeddable}`);
    }
    throw err;
  }

  const ps = info.playability_status;
  console.log(`stream extract: client=${client}: status=${ps?.status} has_streaming=${!!info.streaming_data} formats=${info.streaming_data?.adaptive_formats?.length ?? 0}`);

  const formats = info.streaming_data?.adaptive_formats ?? [];

  for (const f of formats) {
    if (!f.has_audio || f.has_video) continue;

    if (f.url) return f.url;

    if (f.cipher || f.signature_cipher) {
      const player = yt.actions.session.player;
      if (player) {
        const deciphered = await f.decipher(player);
        if (deciphered) return deciphered;
      }
    }
  }

  return null;
}

async function doExtract(videoId: string): Promise<string | null> {
  const existing = pending.get(videoId);
  if (existing) return existing;

  const promise = (async () => {
    for (const client of CLIENTS) {
      try {
        const url = await tryExtract(videoId, client);
        if (url) {
          setCache(videoId, url).catch(() => {});
          return url;
        }
      } catch (err) {
        console.error(`stream extract: client=${client} videoId=${videoId}:`, err);
      }
    }
    return null;
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
    hasSession: !!_innertube,
    cookieLogin: _cookieLogin,
    source: _cookieSource,
    ytCookiesSet: !!process.env.YT_COOKIES,
    ytCookiesFileSet: !!process.env.YT_COOKIES_FILE,
    ytCookiesFileExists: process.env.YT_COOKIES_FILE
      ? existsSync(process.env.YT_COOKIES_FILE)
      : false,
  };
}

export async function testExtract(videoId: string) {
  const start = Date.now();
  const url = await doExtract(videoId);
  const elapsed = Date.now() - start;

  return {
    cookies: getCookieStatus(),
    extract: {
      youtubeijs: {
        ok: !!url,
        elapsed,
        hasUrl: !!url,
      },
    },
  };
}
