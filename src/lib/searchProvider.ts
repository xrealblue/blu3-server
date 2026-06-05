import { getRedis } from "./redis.js";
import { getYTMusic, searchSongsWithRealVideoIds } from "./ytmusic.js";

export interface SearchTrack {
  id: string;
  videoId: string;
  name: string;
  duration_ms: number;
  explicit: boolean;
  artists: { name: string }[];
  album: { name: string };
  image: string;
}

export interface SearchResult {
  tracks: SearchTrack[];
}

export interface SearchProvider {
  search(query: string): Promise<SearchResult>;
}

const CACHE_TTL = 21600;

export class YtMusicSearchProvider implements SearchProvider {
  async search(query: string): Promise<SearchResult> {
    const normalized = query.trim().toLowerCase();
    const r = getRedis();

    if (r) {
      const cached = await r.get<SearchResult>(`search:${normalized}`);
      if (cached) return cached;
    }

    try {
      const yt = await getYTMusic();
      const results = await searchSongsWithRealVideoIds(normalized);

      const tracks: SearchTrack[] = results.map((r: any) => {
        const thumbs = r.thumbnails ?? [];
        const thumb = thumbs[thumbs.length - 1]?.url ?? "";
        const image = thumb.replace(/=w\d+-h\d+.*$/, "=w226-h226-l90-rj");
        return {
          id: r.videoId,
          videoId: r.videoId,
          name: r.name,
          duration_ms: (r.duration ?? 0) * 1000,
          explicit: false,
          artists: r.artist ? [{ name: r.artist.name }] : [],
          album: { name: r.album?.name ?? "" },
          image,
        };
      });

      const result: SearchResult = { tracks };

      if (r) {
        await r.setex(`search:${normalized}`, CACHE_TTL, JSON.stringify(result));
      }

      return result;
    } catch (err) {
      console.error("[SearchProvider] search error:", err);
      return { tracks: [] };
    }
  }
}
