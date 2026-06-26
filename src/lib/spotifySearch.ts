import { getCached, setCache } from "./responseCache.js";

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || "";
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "";

interface SpotifyToken {
  access_token: string;
  expires_at: number;
}

let tokenCache: SpotifyToken | null = null;

async function getToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expires_at) {
    return tokenCache.access_token;
  }

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: SPOTIFY_CLIENT_ID,
      client_secret: SPOTIFY_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify token error (${res.status}): ${text}`);
  }

  const data = await res.json();
  tokenCache = {
    access_token: data.access_token,
    expires_at: Date.now() + data.expires_in * 1000 - 120000,
  };
  return data.access_token;
}

export interface SpotifyTrackResult {
  id: string;
  name: string;
  artists: string;
  album: string;
  cover: string;
  duration_ms: number;
  uri: string;
}

export async function searchSpotify(query: string, limit = 10): Promise<SpotifyTrackResult[]> {
  const cacheKey = `spotify:search:${query}:${limit}`;
  const cached = getCached(cacheKey);
  if (cached) return cached as SpotifyTrackResult[];

  const token = await getToken();
  const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    if (res.status === 401) {
      tokenCache = null;
      return searchSpotify(query, limit);
    }
    throw new Error(`Spotify search error (${res.status})`);
  }

  const data = await res.json();
  const items = data.tracks?.items || [];

  const results: SpotifyTrackResult[] = items.map((t: any) => ({
    id: t.id,
    name: t.name,
    artists: t.artists.map((a: any) => a.name).join(", "),
    album: t.album?.name || "",
    cover: t.album?.images?.[0]?.url || "",
    duration_ms: t.duration_ms,
    uri: t.uri,
  }));

  setCache(cacheKey, results);
  return results;
}

export async function getSpotifyTrackById(id: string): Promise<SpotifyTrackResult | null> {
  const cacheKey = `spotify:track:${id}`;
  const cached = getCached(cacheKey);
  if (cached) return cached as SpotifyTrackResult;

  const token = await getToken();
  const url = `https://api.spotify.com/v1/tracks/${id}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    if (res.status === 401) {
      tokenCache = null;
      return getSpotifyTrackById(id);
    }
    return null;
  }

  const t = await res.json();
  const result: SpotifyTrackResult = {
    id: t.id,
    name: t.name,
    artists: t.artists.map((a: any) => a.name).join(", "),
    album: t.album?.name || "",
    cover: t.album?.images?.[0]?.url || "",
    duration_ms: t.duration_ms,
    uri: t.uri,
  };

  setCache(cacheKey, result);
  return result;
}
