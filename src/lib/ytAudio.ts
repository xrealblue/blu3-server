
import YTMusic from "ytmusic-api";
import { execSync } from "child_process";
import ytdl from "ytdl-core-enhanced";
import { existsSync } from "fs";

let ytmusicInstance: YTMusic | null = null;
async function getYTMusic(): Promise<YTMusic> {
  if (!ytmusicInstance) {
    ytmusicInstance = new YTMusic();
    await ytmusicInstance.initialize();
    const fallbackKey = process.env.YTMUSIC_API_KEY;
    if (!(ytmusicInstance as any).apiKey && fallbackKey) {
      (ytmusicInstance as any).apiKey = fallbackKey;
      (ytmusicInstance as any).context = {
        client: {
          clientName: "WEB_REMIX",
          clientVersion: process.env.YTMUSIC_CLIENT_VERSION || "1.20250204.01.00",
        },
      };
    }
  }
  return ytmusicInstance;
}

export interface YouTubeSearchResult {
  videoId: string;
  thumbnail: string;
  durationMs: number;
}

export interface YouTubeMusicSearchResult {
  videoId: string;
  name: string;
  artist: string;
  thumbnail: string;
  durationMs: number;
}

function upscaleThumbnail(url: string): string {
  if (!url) return url;
  if (url.includes("i.ytimg.com/vi/")) {
    return url.replace(/\/[a-z]+default\.jpg$/, "/maxresdefault.jpg");
  }
  if (url.includes("googleusercontent.com")) {
    return url.replace(/=s\d+/, "=s1080").replace(/=w\d+-h\d+/, "=s1080");
  }
  return url;
}

function bestThumbnail(thumbnails: Array<{ url: string; width: number; height: number }>): string {
  return upscaleThumbnail(thumbnails?.at(-1)?.url || "");
}

export async function searchYouTubeWithMetadata(query: string): Promise<YouTubeSearchResult | null> {
  try {
    const yt = await getYTMusic();
    const results = await yt.searchSongs(query);
    if (!results[0]) return null;
    const s = results[0];
    return {
      videoId: s.videoId,
      thumbnail: bestThumbnail(s.thumbnails) || `https://i.ytimg.com/vi/${s.videoId}/maxresdefault.jpg`,
      durationMs: (s.duration || 0) * 1000,
    };
  } catch (err) {
    console.error(`[ytAudio] searchYouTubeWithMetadata("${query}") failed:`, err);
    return null;
  }
}

export async function searchYouTubeResults(query: string): Promise<YouTubeMusicSearchResult[]> {
  try {
    const yt = await getYTMusic();
    const results = await yt.searchSongs(query);
    return results.slice(0, 10).map((s) => ({
      videoId: s.videoId,
      name: s.name,
      artist: s.artist?.name || "",
      thumbnail: bestThumbnail(s.thumbnails) || "",
      durationMs: (s.duration || 0) * 1000,
    }));
  } catch (err) {
    console.error(`[ytAudio] searchYouTubeResults("${query}") failed:`, err);
    return [];
  }
}

export async function getYoutubeMusicAlbumArt(name: string, artist?: string): Promise<string | null> {
  try {
    const yt = await getYTMusic();
    const query = artist ? `${name} ${artist}` : name;
    const results = await yt.searchSongs(query);
    if (!results[0]) return null;
    return bestThumbnail(results[0].thumbnails) || null;
  } catch (err) {
    console.error(`[ytAudio] getYoutubeMusicAlbumArt failed:`, err);
    return null;
  }
}

function tryYtDlp(videoId: string): string | null {
  const url = `"https://youtube.com/watch?v=${videoId}"`;
  const cookiesFile = process.env.YT_COOKIES_FILE || "./cookies.txt";
  const hasCookies = existsSync(cookiesFile);
  const hasWarp = process.platform !== "win32";

  const strategies: Array<{ name: string; cmd: string; timeout: number }> = [
    { name: "yt-dlp default", cmd: `yt-dlp --no-update -f bestaudio -g ${url}`, timeout: 20000 },
  ];

  if (hasWarp) {
    strategies.push(
      { name: "yt-dlp default + WARP", cmd: `yt-dlp --proxy socks5://127.0.0.1:1080 --no-update -f bestaudio -g ${url}`, timeout: 20000 },
      { name: "yt-dlp tv_downgraded + WARP", cmd: `yt-dlp --proxy socks5://127.0.0.1:1080 --no-update --extractor-args "youtube:player_client=tv_downgraded" -f bestaudio -g ${url}`, timeout: 20000 },
    );
  }

  if (hasCookies) {
    strategies.push(
      { name: "yt-dlp web + cookies", cmd: `yt-dlp --no-update --cookies ${cookiesFile} -f bestaudio -g ${url}`, timeout: 15000 },
    );
  }

  for (const { name, cmd, timeout } of strategies) {
    try {
      console.log(`[ytAudio] tryYtDlp — trying: ${name}`);
      const result = execSync(cmd, { timeout, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
      const audioUrl = result.trim().split("\n")[0];
      if (audioUrl && audioUrl.startsWith("http")) {
        console.log(`[ytAudio] tryYtDlp — SUCCESS: ${name}`);
        return audioUrl;
      }
      console.log(`[ytAudio] tryYtDlp — ${name} returned non-URL: ${audioUrl?.slice(0, 80)}`);
    } catch (err: any) {
      const stderr = err?.stderr?.toString()?.slice(0, 200) || "";
      const msg = err?.message?.slice(0, 120) || "unknown";
      console.error(`[ytAudio] tryYtDlp — ${name} FAILED: ${msg}`);
      if (stderr) console.error(`[ytAudio] tryYtDlp — ${name} stderr: ${stderr}`);
    }
  }
  console.error(`[ytAudio] tryYtDlp — ALL STRATEGIES FAILED for ${videoId}`);
  return null;
}

async function tryYtdlCore(videoId: string, signal?: AbortSignal): Promise<string | null> {
  try {
    console.log(`[ytAudio] tryYtdlCore — fetching info for ${videoId}`);
    const info = await ytdl.getInfo(`https://www.youtube.com/watch?v=${videoId}`);
    if (signal?.aborted) {
      console.log(`[ytAudio] tryYtdlCore — aborted`);
      return null;
    }
    const audioFormats = info.formats
      .filter((f: any) => f.mimeType?.startsWith("audio/") && f.hasAudio)
      .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0));
    const url = audioFormats[0]?.url || null;
    if (url) console.log(`[ytAudio] tryYtdlCore — SUCCESS`);
    else console.log(`[ytAudio] tryYtdlCore — no audio formats found`);
    return url;
  } catch (err: any) {
    console.error(`[ytAudio] tryYtdlCore — FAILED: ${err?.message?.slice(0, 120) || "unknown"}`);
    return null;
  }
}

export async function getYouTubeAudioUrl(videoId: string, signal?: AbortSignal, depth = 0): Promise<string | null> {
  if (depth > 2) return null;

  try {
    const yt = await getYTMusic() as any;
    const data = await withSignal(yt.constructRequest("player", { videoId }), signal) as any;
    const actualVideoId = data?.videoDetails?.videoId;
    if (actualVideoId && actualVideoId !== videoId) {
      return getYouTubeAudioUrl(actualVideoId, signal, depth + 1);
    }
    const formats = data?.streamingData?.adaptiveFormats || [];
    const audio = formats
      .filter((f: any) => f.mimeType?.startsWith("audio/"))
      .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    return audio?.url || null;
  } catch (err: any) {
    if (err?.name === "AbortError") return null;
    return null;
  }
}

export async function getYouTubeAudioUrlFull(videoId: string): Promise<string | null> {
  console.log(`[ytAudio] getYouTubeAudioUrlFull — videoId=${videoId} (download mode)`);

  // ── Strategy 1: ytmusic-api ──
  try {
    const yt = await getYTMusic() as any;
    const data = await yt.constructRequest("player", { videoId }) as any;
    const actualVideoId = data?.videoDetails?.videoId;
    if (actualVideoId && actualVideoId !== videoId) {
      console.log(`[ytAudio] ytmusic-api — redirected to ${actualVideoId}`);
      return getYouTubeAudioUrlFull(actualVideoId);
    }
    const formats = data?.streamingData?.adaptiveFormats || [];
    const audio = formats
      .filter((f: any) => f.mimeType?.startsWith("audio/"))
      .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    const ytUrl = audio?.url || null;
    if (ytUrl) {
      console.log(`[ytAudio] ytmusic-api — SUCCESS`);
      return ytUrl;
    }
    console.log(`[ytAudio] ytmusic-api — no audio URL in response`);
  } catch (err: any) {
    console.error(`[ytAudio] ytmusic-api — FAILED: ${err?.message?.slice(0, 120) || "unknown"}`);
  }

  // ── Strategy 2: ytdl-core-enhanced ──
  const ytdlUrl = await tryYtdlCore(videoId);
  if (ytdlUrl) return ytdlUrl;

  // ── Strategy 3+: yt-dlp ──
  const ytdlpUrl = tryYtDlp(videoId);
  if (ytdlpUrl) return ytdlpUrl;

  console.error(`[ytAudio] getYouTubeAudioUrlFull — ALL FALLBACKS FAILED for ${videoId}`);
  return null;
}

function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }),
  ]);
}

export async function getYouTubeVideoInfo(videoId: string): Promise<{ title: string; artist: string; thumbnail: string } | null> {
  try {
    const yt = await getYTMusic();
    const info = await yt.getSong(videoId);
    return {
      title: info.name || "",
      artist: info.artist?.name || "",
      thumbnail: bestThumbnail(info.thumbnails) || `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
    };
  } catch (err) {
    console.error(`[ytAudio] getYouTubeVideoInfo("${videoId}") failed:`, err);
    return null;
  }
}
