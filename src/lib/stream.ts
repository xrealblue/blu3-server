import { Innertube } from "youtubei.js";
import { existsSync, mkdirSync, createReadStream, createWriteStream, renameSync, unlinkSync } from "fs";
import { resolve } from "path";

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

let innertubeInstance: Innertube | null = null;

async function getInnertube(): Promise<Innertube> {
  if (innertubeInstance) return innertubeInstance;
  const cookie = process.env.YT_COOKIES || "";
  innertubeInstance = await Innertube.create({
    cookie,
  });
  return innertubeInstance;
}

export function resetInnertube(): void {
  innertubeInstance = null;
}

async function fetchStreamUrl(videoId: string): Promise<{ url: string; mimeType: string } | null> {
  try {
    const yt = await getInnertube();
    const info = await yt.getInfo(videoId);

    const formats = info.chooseFormat({ type: "audio", quality: "best" });
    if (!formats) {
      console.log(`[stream] no audio format for ${videoId}`);
      return null;
    }

    const format = Array.isArray(formats) ? formats[0] : formats;
    const url = format?.decipher(yt.session.player) || "";
    if (!url) {
      console.log(`[stream] no deciphered URL for ${videoId}`);
      return null;
    }

    const mimeType = format.mime_type?.split(";")[0]?.trim() || "audio/mp4";
    console.log(`[stream] got stream for ${videoId} (${mimeType})`);
    return { url, mimeType };
  } catch (err: any) {
    console.error(`[stream] error for ${videoId}:`, err.message);
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
