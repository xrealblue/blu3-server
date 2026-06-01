import { Innertube, Platform } from "youtubei.js";
import vm from "node:vm";
import { unifiedGet, unifiedSet, unifiedDel } from "./redis.js";

const CACHE_PREFIX = "stream:";
const pending = new Map<string, Promise<string | null>>();

const CLIENTS = ["TV_EMBEDDED", "ANDROID", "TV", "ANDROID_VR", "TV_SIMPLY", "WEB"] as const;
const badClients = new Set<string>();

let _innertube: Innertube | null = null;
let _cookieSource = "hardcoded";
let _cookieLogin = false;
let _sessionRecreations = 0;
let _sessionCreatedAt = 0;

const _HARDCODED_COOKIES = "HSID=A-kL7ECSQxomtf8kj;SSID=AfbtKcjg2BH7qH-ks;APISID=ZmNEf2SsDvRTwqM3/AVFhf67_9JmBsb73p;SAPISID=GKc_-nxgkQWFDNwz/Aeq9NfF-ayceNeQwl;__Secure-1PAPISID=GKc_-nxgkQWFDNwz/Aeq9NfF-ayceNeQwl;__Secure-3PAPISID=GKc_-nxgkQWFDNwz/Aeq9NfF-ayceNeQwl;LOGIN_INFO=AFmmF2swRgIhAIRaEa2JgwGlCNGdhozqKz7tyfwdIm8Qm8HFTyYQ-jZdAiEAkor0-D55vc4OzMueAMXBGKtY2TqjUcU221bhP3V7AFA:QUQ3MjNmeXItSDF2VjVzZG5wOUdoMVdaRlZranlmdHhiOGZzSTdIdHlmcTFyelU2eXlzVmFveWxXYkI4aV9XcG9WZVg5MGNaLWZPX1lfUFVaTGZFSzhmLTFRXzJMb1RDVG9STDJSd1JFdDhEZC0xbXZWQXBqZEwydmsyTkVpMHpQVjlJNmdSbnZzdTl4N0hfY0pIYVY1b1Y2TkwwR2FDODZR;SID=g.a000-ghKdatfYaGdHA-ilMQ6XpU6X77thla5CbzBWF6GEBQ5QGH5QiWGvBC0nejzouKYrA7iwgACgYKAYUSARMSFQHGX2MikegO0pXl2BpJH-4IqGag9xoVAUF8yKqn213yTpWa3Liej5qHlZEM0076;__Secure-1PSID=g.a000-ghKdatfYaGdHA-ilMQ6XpU6X77thla5CbzBWF6GEBQ5QGH59FSmvsKjeUkO68CG7b0g6AACgYKATwSARMSFQHGX2Mi9N24_hUXnrW5TR6y9nsVbRoVAUF8yKq-ct-66t3N4ZG6FEkCL3dE0076;__Secure-3PSID=g.a000-ghKdatfYaGdHA-ilMQ6XpU6X77thla5CbzBWF6GEBQ5QGH5rbb1-Zmt4JmU3mQ5jrd-qwACgYKAUgSARMSFQHGX2MiA8bzW_TpxWjYfgkFPqZCJRoVAUF8yKqPbBglCGbduyoSZ-mKjbJS0076;PREF=f4=4000000&f6=40000000&tz=Asia.Calcutta;__Secure-1PSIDTS=sidts-CjQBhkeRd57mbdBzsv0i8SWO2EBnEkUBaF-uG8ugLI_goBKR3gZ02hwdPcnRuiPWnIyCoiIxEAA;__Secure-3PSIDTS=sidts-CjQBhkeRd57mbdBzsv0i8SWO2EBnEkUBaF-uG8ugLI_goBKR3gZ02hwdPcnRuiPWnIyCoiIxEAA;SIDCC=AKEyXzXhIusl5j-nXte-NIZAcP6c70ZzS2INpgBxcWupYbi3fq6JUyvZ7nW_M8ywhLeIbZwA;__Secure-1PSIDCC=AKEyXzU8DLhMZ7nmoUi971ZOlCVOSNSWq0F5f8z_e4NK8tOxJv435tsGQ4jNrBvDWoERpm8r6A;__Secure-3PSIDCC=AKEyXzVGJGq60ykhuUwxmTFTggGhN9JULo5UEWFywstjXmb0dbIc0LN98CKoTednL_ZXKY3K";

function loadCookieString(): string | undefined {
  return _HARDCODED_COOKIES;
}

// Override youtubei.js's default JS evaluator with Node.js vm for signature deciphering
Platform.shim.eval = async (data, env) => {
  const context = vm.createContext({
    Object, Array, String, Number, Boolean, BigInt,
    Math, JSON, RegExp, Map, Set, WeakMap, WeakSet, Promise,
    Error, TypeError, RangeError, ReferenceError, SyntaxError, EvalError, URIError,
    parseInt, parseFloat, isNaN, isFinite, decodeURI, encodeURI,
    encodeURIComponent, decodeURIComponent, escape, unescape,
    URL, URLSearchParams,
    console, setTimeout, clearTimeout, setInterval, clearInterval, Buffer,
    Symbol, Reflect, Proxy, Date, Atomics, SharedArrayBuffer, Intl,
  });
  const wrapped = `(function(){\n${data.output}\n})()`;
  return vm.runInContext(wrapped, context);
};

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
  _sessionCreatedAt = Date.now();
  return _innertube;
}

function resetSession(): void {
  if (_innertube) {
    _innertube = null;
    _sessionRecreations++;
    console.warn(`[Session] Innertube session reset (#${_sessionRecreations})`);
  }
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

async function tryExtract(videoId: string, client: string, retried = false): Promise<string | null> {
  const yt = await getInnertube();
  const override = client as any;

  let info: any;
  try {
    info = await yt.getBasicInfo(videoId, { client: override });
  } catch (err: any) {
    if (err.info?.status === 'ERROR') {
      console.error(`stream extract: client=${client}: playability_status=ERROR reason="${err.info?.reason}" embeddable=${err.info?.embeddable}`);
    }
    if (err.info?.status === 'LOGIN_REQUIRED') {
      console.warn(`stream extract: client=${client}: LOGIN_REQUIRED — resetting session and retrying`);
      resetSession();
      if (!retried) {
        const yt2 = await getInnertube();
        info = await yt2.getBasicInfo(videoId, { client: override });
      } else {
        throw err;
      }
    } else {
      if (err.stack?.includes?.("PlayerErrorCommand") || String(err).includes("PlayerErrorCommand")) {
        badClients.add(client);
        console.warn(`stream extract: client=${client} — added to badClients set (PlayerErrorCommand)`);
      }
      throw err;
    }
  }

  const ps = info.playability_status;
  if (ps?.status === 'LOGIN_REQUIRED') {
    console.warn(`stream extract: client=${client}: LOGIN_REQUIRED in playability_status — resetting session and retrying`);
    resetSession();
    if (!retried) {
      const yt2 = await getInnertube();
      info = await yt2.getBasicInfo(videoId, { client: override });
      const ps2 = info.playability_status;
      if (ps2?.status === 'LOGIN_REQUIRED') return null;
    } else {
      return null;
    }
  }

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
    if (badClients.size > 0) {
      console.log(`stream extract: skipping badClients: ${[...badClients].join(", ")}`);
    }
    const clients = CLIENTS.filter((c) => !badClients.has(c));
    for (const client of clients) {
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
    sessionAge: _sessionCreatedAt ? Date.now() - _sessionCreatedAt : null,
    sessionRecreations: _sessionRecreations,
    badClients: [...badClients],
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
