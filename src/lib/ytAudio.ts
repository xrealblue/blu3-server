
import YTMusic from "ytmusic-api";

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

export async function getYouTubeAudioUrl(videoId: string, signal?: AbortSignal, depth = 0): Promise<string | null> {
  if (depth > 2) return null;
  try {
    const yt = await getYTMusic() as any;
    const data = await withSignal(yt.constructRequest("player", { videoId }), signal) as any;
    const actualVideoId = data?.videoDetails?.videoId;
    if (actualVideoId && actualVideoId !== videoId) {
      // YouTube redirected the requested videoId to a different video (common in mix/radio URLs).
      // Re-fetch with the actual videoId to get the correct streaming data.
      return getYouTubeAudioUrl(actualVideoId, signal, depth + 1);
    }
    const formats = data?.streamingData?.adaptiveFormats || [];
    const audio = formats
      .filter((f: any) => f.mimeType?.startsWith("audio/"))
      .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0];
    return audio?.url || null;
  } catch (err: any) {
    if (err?.name === "AbortError") return null;
    console.error(`[ytAudio] getYouTubeAudioUrl("${videoId}") failed:`, err);
    return null;
  }
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
