import { getRedis } from "./redis.js";
import { getAudioUrl } from "./ytdl.js";

export interface ResolvedAudio {
  url: string;
  videoId: string;
  expiresAt: number;
}

export interface AudioResolver {
  resolve(videoId: string): Promise<ResolvedAudio | null>;
}

const CACHE_TTL = 3600;
const LOCK_TTL = 10;
const POLL_INTERVAL = 200;
const POLL_TIMEOUT = 15000;

const inFlightLocks = new Map<string, Promise<string | null>>();

export class YtDlpResolver implements AudioResolver {
  async resolve(videoId: string): Promise<ResolvedAudio | null> {
    const r = getRedis();

    if (r) {
      const cached = await r.get<string>(`audio:url:${videoId}`);
      if (cached) {
        return { url: cached, videoId, expiresAt: Date.now() + CACHE_TTL * 1000 };
      }
    }

    const existing = inFlightLocks.get(videoId);
    if (existing) {
      const url = await existing;
      if (url) return { url, videoId, expiresAt: Date.now() + CACHE_TTL * 1000 };
      return null;
    }

    const promise = this.resolveInner(videoId, r);
    inFlightLocks.set(videoId, promise);
    try {
      const url = await promise;
      if (url) return { url, videoId, expiresAt: Date.now() + CACHE_TTL * 1000 };
      return null;
    } finally {
      inFlightLocks.delete(videoId);
    }
  }

  private async resolveInner(videoId: string, r: ReturnType<typeof getRedis>): Promise<string | null> {
    if (r) {
      const locked = await r.set(`audio:lock:${videoId}`, "1", { nx: true, ex: LOCK_TTL });
      if (!locked) {
        return this.pollCache(videoId, r);
      }
    }

    try {
      const url = await getAudioUrl(videoId);
      if (url && r) {
        await r.setex(`audio:url:${videoId}`, CACHE_TTL, url);
      }
      return url;
    } catch (err) {
      console.error(`[AudioResolver] yt-dlp failed for ${videoId}:`, err);
      if (r) await r.del(`audio:lock:${videoId}`);
      return null;
    }
  }

  private async pollCache(videoId: string, r: ReturnType<typeof getRedis>): Promise<string | null> {
    const deadline = Date.now() + POLL_TIMEOUT;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL);
      const cached = await r!.get<string>(`audio:url:${videoId}`);
      if (cached) return cached;
      const lockStillHeld = await r!.exists(`audio:lock:${videoId}`);
      if (!lockStillHeld) break;
    }
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
