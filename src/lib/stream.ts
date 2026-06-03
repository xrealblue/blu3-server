import { existsSync, mkdirSync, createReadStream, createWriteStream, renameSync, unlinkSync } from "fs";
import { resolve } from "path";

const YT_API_URL = "https://www.youtube.com/youtubei/v1/player";
const API_KEYS = [
  process.env.YOUTUBE_API_KEY,
  "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
  "AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w",
].filter(Boolean) as string[];

const CACHE_DIR = resolve(process.env.CDN_CACHE_DIR || "cache");
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

const downloadsInProgress = new Map<string, Promise<string>>();

function extFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes("mp4") || m.includes("m4a")) return "m4a";
  if (m.includes("webm")) return "webm";
  if (m.includes("opus")) return "opus";
  return "m4a";
}

async function fetchStreamUrl(videoId: string): Promise<{ url: string; mimeType: string } | null> {
  const cookie = process.env.YT_COOKIES || "";

  for (const apiKey of API_KEYS) {
    const body = {
      videoId,
      context: {
        client: {
          clientName: "ANDROID",
          clientVersion: "19.09.37",
          androidSdkVersion: 30,
        },
      },
    };

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (cookie) headers["Cookie"] = cookie;

    try {
      const resp = await fetch(`${YT_API_URL}?key=${apiKey}`, {
        method: "POST",
        body: JSON.stringify(body),
        headers,
      });
      if (!resp.ok) continue;

      const data: any = await resp.json();
      if (!data.streamingData) continue;

      const formats = [...(data.streamingData.adaptiveFormats || []), ...(data.streamingData.formats || [])];
      const audioFormat = formats.find((f: any) => !f.hasVideo && (f.mimeType || "").includes("audio") && f.url);
      if (!audioFormat) continue;

      return { url: audioFormat.url, mimeType: audioFormat.mimeType.split(";")[0].trim() };
    } catch {}
  }

  return null;
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
