import CryptoJS from "crypto-js";

const JIOSAAVN_DES_KEY = "38346591";
const SEARCH_BASE = "https://www.jiosaavn.com/api.php";
const SONG_BASE = "https://www.jiosaavn.com/api.php";

interface JioSong {
  id: string;
  title: string;
  album: string;
  artists: string;
  image: string;
  duration: number;
  has320: boolean;
  encryptedUrl: string;
}

interface ResolveResult {
  url: string;
  source: "jiosaavn";
  videoId: string;
}

export interface JioSearchTrack {
  id: string;
  videoId: string;
  name: string;
  duration_ms: number;
  artists: { name: string }[];
  album: { name: string };
  image: string;
  source: string;
}

function decryptMediaUrl(encrypted: string): string {
  const key = CryptoJS.enc.Utf8.parse(JIOSAAVN_DES_KEY);
  const ciphertext = CryptoJS.enc.Base64.parse(encrypted);
  const decrypted = CryptoJS.DES.decrypt(
    { ciphertext } as any,
    key,
    { mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.NoPadding },
  );
  const result = CryptoJS.enc.Utf8.stringify(decrypted);
  return result.replace(/[^\x20-\x7E]/g, "").trim();
}

function getBestQualityUrl(encryptedUrl: string, has320: boolean): string {
  const baseUrl = decryptMediaUrl(encryptedUrl);
  if (!baseUrl) return "";
  if (has320) {
    return baseUrl.replace(/_(96|128)(?=[._])/, "_320");
  }
  return baseUrl;
}

async function searchJioSaavn(query: string): Promise<JioSong | null> {
  const url = new URL(SEARCH_BASE);
  url.searchParams.set("__call", "search.getResults");
  url.searchParams.set("_format", "json");
  url.searchParams.set("_marker", "0");
  url.searchParams.set("ctx", "wap6dot0");
  url.searchParams.set("q", query);
  url.searchParams.set("n", "5");
  url.searchParams.set("p", "1");

  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: "https://www.jiosaavn.com/",
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) return null;
  const data = await res.json();
  const results: any[] = data?.results ?? [];
  if (results.length === 0) return null;

  const raw = results[0];
  return {
    id: raw.id,
    title: raw.song || raw.title || "",
    album: raw.album || "",
    artists: raw.primary_artists || raw.singers || raw.music || "",
    image: (raw.image || "").replace("150x150", "500x500").replace("50x50", "500x500").replace("1080x1080", "500x500"),
    duration: Number(raw.duration) || 0,
    has320: raw["320kbps"] === "true" || raw["320kbps"] === true,
    encryptedUrl: raw.encrypted_media_url || "",
  };
}

async function getSongDetails(id: string): Promise<JioSong | null> {
  const url = new URL(SONG_BASE);
  url.searchParams.set("__call", "song.getDetails");
  url.searchParams.set("cc", "in");
  url.searchParams.set("_marker", "0");
  url.searchParams.set("_format", "json");
  url.searchParams.set("pids", id);

  const res = await fetch(url.toString(), {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: "https://www.jiosaavn.com/",
    },
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) return null;
  const data = await res.json();
  const raw = data?.[id];
  if (!raw) return null;

  return {
    id: raw.id,
    title: raw.song || raw.title || "",
    album: raw.album || "",
    artists: raw.primary_artists || raw.singers || raw.music || "",
    image: (raw.image || "").replace("150x150", "500x500").replace("50x50", "500x500").replace("1080x1080", "500x500"),
    duration: Number(raw.duration) || 0,
    has320: raw["320kbps"] === "true" || raw["320kbps"] === true,
    encryptedUrl: raw.encrypted_media_url || "",
  };
}

function normalizeQuery(name: string, artists?: string): string {
  let q = name.trim();
  if (artists?.trim()) q += ` ${artists.trim().split(",")[0].trim()}`;
  return q.toLowerCase().replace(/\(.*?\)/g, "").replace(/\[.*?\]/g, "").trim();
}

function normalizeStr(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

function isJioMatch(title: string, expectedTitle: string): boolean {
  const a = normalizeStr(title);
  const b = normalizeStr(expectedTitle);
  return a.includes(b) || b.includes(a);
}

export async function searchJioSaavnResults(query: string): Promise<JioSearchTrack[]> {
  try {
    const url = new URL(SEARCH_BASE);
    url.searchParams.set("__call", "search.getResults");
    url.searchParams.set("_format", "json");
    url.searchParams.set("_marker", "0");
    url.searchParams.set("ctx", "wap6dot0");
    url.searchParams.set("q", normalizeQuery(query));
    url.searchParams.set("n", "20");
    url.searchParams.set("p", "1");

    const res = await fetch(url.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://www.jiosaavn.com/",
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) return [];
    const data = await res.json();
    const results: any[] = data?.results ?? [];

    return results.map((raw: any) => ({
      id: raw.id || "",
      videoId: raw.id || "",
      name: raw.song || raw.title || "",
      duration_ms: (Number(raw.duration) || 0) * 1000,
      artists: [{ name: raw.primary_artists || raw.singers || raw.music || "Unknown" }],
      album: { name: raw.album || "" },
image: (raw.image || "").replace("150x150", "500x500").replace("50x50", "500x500").replace("1080x1080", "500x500"),
      source: "jiosaavn",
    }));
  } catch (err) {
    console.error("[JioSaavn] search failed:", err);
    return [];
  }
}

export async function resolveJioSaavnById(id: string, expectedName?: string): Promise<ResolveResult | null> {
  try {
    const details = await getSongDetails(id);
    if (!details?.encryptedUrl) return null;
    if (expectedName && !isJioMatch(details.title, expectedName)) return null;
    const url = getBestQualityUrl(details.encryptedUrl, details.has320);
    if (url) return { url, source: "jiosaavn", videoId: id };
    return null;
  } catch (err) {
    console.error("[JioSaavn] resolveById failed:", err);
    return null;
  }
}

function isDurationMatch(actualSec: number, expectedMs: number | undefined): boolean {
  if (!expectedMs) return true;
  if (!actualSec) return true;
  return Math.abs(actualSec * 1000 - expectedMs) < 3000;
}

export async function resolveJioSaavn(
  videoId: string,
  name: string,
  artists?: string,
  expectedDuration?: number,
): Promise<ResolveResult | null> {
  try {
    const query = normalizeQuery(name, artists);
    if (!query) return null;

    const song = await searchJioSaavn(query);
    if (!song?.encryptedUrl) return null;

    if (!isJioMatch(song.title, name)) return null;

    if (song.id) {
      const details = await getSongDetails(song.id);
      if (details?.encryptedUrl) {
        if (!isDurationMatch(details.duration, expectedDuration)) return null;
        const url = getBestQualityUrl(details.encryptedUrl, details.has320);
        if (url) return { url, source: "jiosaavn", videoId };
      }
    }

    if (!isDurationMatch(song.duration, expectedDuration)) return null;

    const url = getBestQualityUrl(song.encryptedUrl, song.has320);
    if (url) return { url, source: "jiosaavn", videoId };

    return null;
  } catch (err) {
    console.error("[JioSaavn] resolve failed:", err);
    return null;
  }
}
