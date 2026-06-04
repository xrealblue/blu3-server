import { existsSync, mkdirSync, createReadStream, createWriteStream, renameSync, unlinkSync } from "fs";
import { resolve } from "path";
import { createHash } from "crypto";

const CACHE_DIR = resolve(process.env.CDN_CACHE_DIR || "cache");
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

const downloadsInProgress = new Map<string, { promise: Promise<string>; streamUrl: string }>();
const streamUrlCache = new Map<string, string>();

function extFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("mp4") || m.includes("m4a")) return "m4a";
  if (m.includes("webm")) return "webm";
  if (m.includes("opus")) return "opus";
  return "m4a";
}

function parseCookies(cookieString: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of cookieString.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.substring(0, eq).trim();
    const val = part.substring(eq + 1).trim();
    result[key] = val;
  }
  return result;
}

function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

function buildHeaders(cookieString: string): Record<string, string> {
  const cookies = parseCookies(cookieString);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const cookieParts: string[] = [];
  for (const [key, val] of Object.entries(cookies)) {
    cookieParts.push(`${key}=${val}`);
  }
  if (cookieParts.length > 0) {
    headers["Cookie"] = cookieParts.join("; ");
  }

  const sapisid = cookies["__Secure-3PAPISID"] || cookies["SAPISID"] || cookies["__Secure-1PAPISID"] || "";
  if (sapisid) {
    const time = Math.floor(Date.now() / 1000);
    const hash = sha1(`${time} ${sapisid} https://www.youtube.com`);
    headers["Authorization"] = `SAPISIDHASH ${time}_${hash}`;
    headers["X-Origin"] = "https://www.youtube.com";
    headers["Origin"] = "https://www.youtube.com";
  }

  return headers;
}

const API_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

function buildRequestBody(videoId: string): any {
  return {
    videoId,
    context: {
      client: {
        clientName: "WEB",
        clientVersion: "2.20250204.00.00",
        hl: "en",
        gl: "US",
      },
    },
    contentCheckOk: true,
    racyCheckOk: true,
  };
}

async function fetchStreamUrl(videoId: string): Promise<{ url: string; mimeType: string } | null> {
  const cookieString = process.env.YT_COOKIES || "";
  if (!cookieString) {
    console.error("[stream] No YT_COOKIES set");
    return null;
  }

  try {
    const resp = await fetch(
      `https://www.youtube.com/youtubei/v1/player?key=${API_KEY}`,
      {
        method: "POST",
        body: JSON.stringify(buildRequestBody(videoId)),
        headers: buildHeaders(cookieString),
      },
    );

    if (!resp.ok) {
      const text = await resp.text();
      console.error(`[stream] player API ${resp.status}: ${text.slice(0, 200)}`);
      return null;
    }

    const data: any = await resp.json();

    const formats = data?.streamingData?.adaptiveFormats || data?.streamingData?.formats || [];
    const audioFormats = formats.filter(
      (f: any) => (f.mimeType || "").toLowerCase().includes("audio"),
    );

    if (audioFormats.length === 0) {
      console.error(`[stream] no audio formats for ${videoId}`);
      return null;
    }

    for (const f of audioFormats) {
      let url = f.url || null;
      if (!url && f.signatureCipher) {
        const params = new URLSearchParams(f.signatureCipher);
        url = params.get("url");
      }
      if (!url && f.cipher) {
        const params = new URLSearchParams(f.cipher);
        url = params.get("url");
      }
      if (url) {
        const mimeType = (f.mimeType || "").split(";")[0].trim() || "audio/mp4";
        console.log(`[stream] got stream for ${videoId}`);
        return { url, mimeType };
      }
    }

    console.error(`[stream] no decipherable URL for ${videoId}`);
    return null;
  } catch (err: any) {
    console.error(`[stream] fetch error for ${videoId}:`, err.message);
    return null;
  }
}

function cachePath(videoId: string, ext: string): string {
  return resolve(CACHE_DIR, `${videoId}.${ext}`);
}

function tmpPath(videoId: string, ext: string): string {
  return resolve(CACHE_DIR, `${videoId}.${ext}.downloading`);
}

export async function getCachedFile(videoId: string): Promise<{ path: string; mimeType: string } | null> {
  for (const ext of ["m4a", "webm", "opus"]) {
    const p = cachePath(videoId, ext);
    if (existsSync(p)) {
      const mime = ext === "m4a" ? "audio/mp4" : ext === "webm" ? "audio/webm" : "audio/opus";
      return { path: p, mimeType: mime };
    }
  }
  return null;
}

export async function ensureCached(videoId: string): Promise<{ url: string; mimeType: string } | null> {
  const cached = await getCachedFile(videoId);
  if (cached) {
    console.log(`[cdn] cache hit for ${videoId}`);
    return { url: "", mimeType: cached.mimeType };
  }

  const cachedUrl = streamUrlCache.get(videoId);
  if (cachedUrl) {
    console.log(`[cdn] cached stream URL for ${videoId}`);
    return { url: cachedUrl, mimeType: "audio/mp4" };
  }

  const existing = downloadsInProgress.get(videoId);
  if (existing) {
    console.log(`[cdn] download already in progress for ${videoId}, waiting`);
    try {
      const ext = await existing.promise;
      const mime = ext === "m4a" ? "audio/mp4" : ext === "webm" ? "audio/webm" : "audio/opus";
      if (existing.streamUrl) streamUrlCache.set(videoId, existing.streamUrl);
      return { url: existing.streamUrl, mimeType: mime };
    } catch {
      downloadsInProgress.delete(videoId);
      console.log(`[cdn] previous download failed for ${videoId}, retrying`);
    }
  }

  const result = await fetchStreamUrl(videoId);
  if (!result) return null;

  streamUrlCache.set(videoId, result.url);

  const ext = extFromMime(result.mimeType);
  const tmp = tmpPath(videoId, ext);
  const finalPath = cachePath(videoId, ext);

  const downloadPromise = (async (): Promise<string> => {
    try {
      const streamResp = await fetch(result.url);
      if (!streamResp.ok) throw new Error(`CDN fetch failed: ${streamResp.status}`);
      const reader = streamResp.body?.getReader();
      if (!reader) throw new Error("No response body");

      const writer = createWriteStream(tmp);
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          writer.write(value);
        }
        writer.end();
      };
      await pump;
      renameSync(tmp, finalPath);
      console.log(`[cdn] cached ${videoId} (${ext})`);
      return ext;
    } catch (err: any) {
      console.error(`[cdn] download failed for ${videoId}:`, err.message);
      try { unlinkSync(tmp); } catch {}
      return "";
    }
  })();

  downloadsInProgress.set(videoId, { promise: downloadPromise, streamUrl: result.url });
  downloadPromise.finally(() => {
    downloadsInProgress.delete(videoId);
    streamUrlCache.delete(videoId);
  });

  return { url: result.url, mimeType: result.mimeType };
}

export async function fetchStreamUrlOnly(videoId: string): Promise<{ url: string; mimeType: string } | null> {
  return fetchStreamUrl(videoId);
}
