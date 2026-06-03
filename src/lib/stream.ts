import { existsSync, mkdirSync, createReadStream, createWriteStream, renameSync, unlinkSync, readFileSync } from "fs";
import { resolve } from "path";

const YT_API_URL = "https://www.youtube.com/youtubei/v1/player";
const API_KEYS = [
  "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8",
  process.env.YOUTUBE_API_KEY,
].filter(Boolean) as string[];

const CLIENTS = [
  { name: "ANDROID", version: "19.09.37", androidSdk: 30 },
  { name: "ANDROID_MUSIC", version: "6.52.52", androidSdk: 30 },
  { name: "WEB", version: "2.20250314.07.00" },
  { name: "ANDROID_CREATOR", version: "24.10.100", androidSdk: 30 },
];

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
  for (const apiKey of API_KEYS) {
    for (const client of CLIENTS) {
      const body: Record<string, any> = {
        videoId,
        context: {
          client: {
            clientName: client.name,
            clientVersion: client.version,
            hl: "en",
            gl: "US",
            utcOffsetMinutes: 0,
          },
        },
        playbackContext: {
          contentPlaybackContext: {
            html5Preference: "HTML5_PREF_WANTS",
            signatureTimestamp: 20000,
          },
        },
        contentCheckOk: true,
        racyCheckOk: true,
      };
      if (client.androidSdk) {
        body.context.client.androidSdkVersion = client.androidSdk;
      }

      try {
        const resp = await fetch(`${YT_API_URL}?key=${apiKey}`, {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        });

        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          console.log(`[cdn] ${client.name} ${resp.status} for ${videoId}${text ? ": " + text.slice(0, 120) : ""}`);
          continue;
        }

        const data: any = await resp.json();

        if (!data.streamingData) {
          const reason = data.playabilityStatus?.reason || "no streamingData";
          const status = data.playabilityStatus?.status || "UNKNOWN";
          if (status !== "OK") {
            console.log(`[cdn] ${client.name} ${status} for ${videoId}: ${reason}`);
            continue;
          }
          console.log(`[cdn] ${client.name} no streamingData for ${videoId}`);
          continue;
        }

        const formats = [...(data.streamingData.adaptiveFormats || []), ...(data.streamingData.formats || [])];
        const audioFormats = formats
          .filter((f: any) => !f.hasVideo && (f.mimeType || "").includes("audio"))
          .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0));

        const best = audioFormats.find((f: any) => f.url) || audioFormats[0];
        if (!best) {
          console.log(`[cdn] ${client.name} no audio format for ${videoId}`);
          continue;
        }

        let url = best.url;
        if (!url && (best.signatureCipher || best.cipher)) {
          console.log(`[cdn] ${client.name} has ciphered URL for ${videoId}, skipping`);
          continue;
        }

        console.log(`[cdn] ${videoId}: ✅ ${client.name} (${Math.round((best.bitrate || 0) / 1000)}kbps)`);
        return { url, mimeType: best.mimeType.split(";")[0].trim() };
      } catch (err: any) {
        console.log(`[cdn] ${client.name} error for ${videoId}: ${err?.message?.slice(0, 80)}`);
      }
    }
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
  const final = cachePath(videoId, ext);

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
      renameSync(tmp, final);
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
