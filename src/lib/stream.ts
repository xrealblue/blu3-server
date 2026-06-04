import { existsSync, mkdirSync, createReadStream, createWriteStream, renameSync, unlinkSync } from "fs";
import { resolve } from "path";
import { buildAuthHeaders, initAuth, resetAuth } from "./youtubeAuth.js";

const YT_API_URL = "https://www.youtube.com/youtubei/v1/player";
const API_KEYS = [
  process.env.YOUTUBE_API_KEY,
  "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
  "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w",
].filter(Boolean) as string[];

const CACHE_DIR = resolve(process.env.CDN_CACHE_DIR || "cache");
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

const downloadsInProgress = new Map<string, Promise<string>>();

const CLIENT_CONTEXTS = [
  { clientName: "ANDROID", clientVersion: "19.09.37" },
  { clientName: "ANDROID_MUSIC", clientVersion: "6.38.54" },
];

function extFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("mp4") || m.includes("m4a")) return "m4a";
  if (m.includes("webm")) return "webm";
  if (m.includes("opus")) return "opus";
  return "m4a";
}

function findAudioFormat(formats: any[]): { url: string; mimeType: string } | null {
  for (const f of [...(formats || [])]) {
    const mime = (f.mimeType || "").toLowerCase();
    if (mime.includes("audio") && f.url && !f.hasVideo) {
      return { url: f.url, mimeType: f.mimeType.split(";")[0].trim() };
    }
  }
  return null;
}

async function fetchStreamUrl(videoId: string): Promise<{ url: string; mimeType: string } | null> {
  let auth;
  try {
    auth = await initAuth();
  } catch {
    console.error("[stream] No YT_COOKIES set, streaming unavailable");
    return null;
  }

  const baseHeaders = buildAuthHeaders(parseCookies(auth.cookieString));

  for (const ctx of CLIENT_CONTEXTS) {
    for (const apiKey of API_KEYS) {
      const body: any = {
        videoId,
        context: {
          client: {
            clientName: ctx.clientName,
            clientVersion: ctx.clientVersion,
            androidSdkVersion: 30,
          },
        },
      };

      if (auth.visitorData) {
        body.context.client.visitorData = auth.visitorData;
      }

      try {
        const resp = await fetch(`${YT_API_URL}?key=${apiKey}`, {
          method: "POST",
          body: JSON.stringify(body),
          headers: baseHeaders,
        });

        if (!resp.ok) {
          const text = await resp.text();
          console.log(`[stream] ${ctx.clientName} (key ${apiKey.slice(0, 8)}...) → ${resp.status} ${text.slice(0, 200)}`);
          continue;
        }

        const data: any = await resp.json();
        if (!data.streamingData) {
          console.log(`[stream] ${ctx.clientName} → no streamingData in response`);
          continue;
        }

        const fmt = findAudioFormat(data.streamingData.adaptiveFormats)
          || findAudioFormat(data.streamingData.formats);

        if (!fmt) {
          console.log(`[stream] ${ctx.clientName} → no audio format found`);
          continue;
        }

        console.log(`[stream] ${ctx.clientName} → got stream for ${videoId}`);
        return fmt;
      } catch (err: any) {
        console.log(`[stream] ${ctx.clientName} → error: ${err.message}`);
      }
    }
  }

  return null;
}

function parseCookies(cookieString: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of cookieString.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    result[part.substring(0, eq).trim()] = part.substring(eq + 1).trim();
  }
  return result;
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

  const existing = downloadsInProgress.get(videoId);
  if (existing) {
    console.log(`[cdn] download already in progress for ${videoId}, waiting`);
    const ext = await existing;
    const mime = ext === "m4a" ? "audio/mp4" : ext === "webm" ? "audio/webm" : "audio/opus";
    return { url: "", mimeType: mime };
  }

  const result = await fetchStreamUrl(videoId);
  if (!result) return null;

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
      try { unlinkSync(tmp); } catch {}
      downloadsInProgress.delete(videoId);
      throw err;
    }
  })();

  downloadsInProgress.set(videoId, downloadPromise);
  downloadPromise.finally(() => downloadsInProgress.delete(videoId));

  return { url: result.url, mimeType: result.mimeType };
}

export async function fetchStreamUrlOnly(videoId: string): Promise<{ url: string; mimeType: string } | null> {
  return fetchStreamUrl(videoId);
}
