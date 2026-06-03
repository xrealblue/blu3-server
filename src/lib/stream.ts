import { Innertube, FormatUtils, Platform } from "youtubei.js";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const CLIENTS = ["TV_EMBEDDED", "ANDROID", "TV", "ANDROID_VR", "TV_SIMPLY", "WEB"] as const;

function sanitizeMimeType(mime: string): string {
  return mime.split(";")[0].trim();
}

Platform.load({
  ...Platform.shim,
  eval: (data, env) => {
    const keys = Object.keys(env);
    const values = keys.map((k) => env[k]);
    return new Function(...keys, data.output)(...values);
  },
});

let ytInstance: Innertube | null = null;
let lastInit = 0;
const INIT_TTL = 1000 * 60 * 30;

function parseNetscapeCookieFile(filePath: string): string {
  try {
    const content = readFileSync(filePath, "utf-8");
    const pairs: string[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("# ") || trimmed.startsWith("# This")) continue;
      const domain = trimmed.startsWith("#HttpOnly_") ? trimmed.slice(10) : trimmed;
      const parts = domain.split("\t");
      if (parts.length >= 7) {
        pairs.push(`${parts[5]}=${parts[6]}`);
      }
    }
    return pairs.join("; ");
  } catch {
    return "";
  }
}

function getCookies(): string {
  const envCookie = process.env.YT_COOKIES || "";
  if (envCookie) return envCookie;

  const filePath = process.env.YT_COOKIES_FILE || resolve("cookies.txt");
  if (existsSync(filePath)) {
    const parsed = parseNetscapeCookieFile(filePath);
    if (parsed) return parsed;
  }

  return "";
}

async function getInstance(clientType?: string): Promise<Innertube> {
  const now = Date.now();
  if (ytInstance && now - lastInit < INIT_TTL && !clientType) return ytInstance;

  const cookie = getCookies();
  const visitorData = process.env.YT_VISITOR_DATA || "";

  const config: Record<string, unknown> = {
    cookie: cookie || undefined,
    visitor_data: visitorData || undefined,
  };
  if (clientType) {
    config.client_type = clientType;
  }

  const instance = await Innertube.create(config);

  if (!clientType) {
    ytInstance = instance;
    lastInit = Date.now();
  }
  return instance;
}

async function decipherFormat(
  format: any,
  player: any,
): Promise<string | undefined> {
  if (format.url || format.signature_cipher || format.cipher) {
    const result = await format.decipher(player);
    return typeof result === "string" ? result : undefined;
  }
  return undefined;
}

async function extractFromInfo(
  videoId: string,
  info: any,
  player: any,
  clientLabel: string,
): Promise<{ url: string; mimeType: string } | null> {
  if (!info.streaming_data) {
    console.log(`[stream] ${videoId}: no streaming_data (client=${clientLabel})`);
    return null;
  }

  const allFormats = [
    ...(info.streaming_data.formats || []),
    ...(info.streaming_data.adaptive_formats || []),
  ];

  // Sort: audio-only first (no video), then combined by lowest video height
  const sortedFormats = [...allFormats].sort((a, b) => {
    if (!a.has_video && b.has_video) return -1;
    if (a.has_video && !b.has_video) return 1;
    return (a.height || 9999) - (b.height || 9999);
  });

  // 1) chooseFormat for best audio
  try {
    const audioFormat = FormatUtils.chooseFormat({ type: "audio", quality: "best", format: "any" }, info.streaming_data);
    const url = await decipherFormat(audioFormat, player);
    if (url) {
      console.log(`[stream] ${videoId}: audio-only itag=${audioFormat.itag} (client=${clientLabel})`);
      return { url, mimeType: sanitizeMimeType(audioFormat.mime_type || "audio/webm") };
    }
  } catch { /* fall through */ }

  // 2) any format with audio (audio-only first, then lowest-video combined)
  for (const f of sortedFormats) {
    if (f.has_audio) {
      const url = await decipherFormat(f, player);
      if (url) {
        console.log(`[stream] ${videoId}: audio format itag=${f.itag} (client=${clientLabel})`);
        return { url, mimeType: sanitizeMimeType(f.mime_type || "audio/webm") };
      }
    }
  }

  // 3) any playable format (sorted by lowest video height)
  for (const f of sortedFormats) {
    if (f.signature_cipher || f.cipher || f.url) {
      const url = await decipherFormat(f, player);
      if (url) {
        console.log(`[stream] ${videoId}: combined format itag=${f.itag} (client=${clientLabel})`);
        return { url, mimeType: sanitizeMimeType(f.mime_type || "audio/mp4") };
      }
    }
  }

  console.log(`[stream] ${videoId}: no playable format (client=${clientLabel})`);
  return null;
}

export async function getAudioStreamUrl(videoId: string): Promise<{ url: string; mimeType: string } | null> {
  // Try default client first
  try {
    const yt = await getInstance();
    console.log(`[stream] fetching info for ${videoId} (client=default)`);
    const info = await yt.getBasicInfo(videoId);
    const result = await extractFromInfo(videoId, info, yt.session!.player, "default");
    if (result) return result;
  } catch (err) {
    console.error(`[stream] default client failed for ${videoId}:`, err);
  }

  // Fallback: try alternative clients
  for (const client of CLIENTS) {
    console.log(`[stream] fetching info for ${videoId} (client=${client})`);
    try {
      const yt = await getInstance(client);
      const info = await yt.getBasicInfo(videoId);
      const result = await extractFromInfo(videoId, info, yt.session!.player, client);
      if (result) {
        console.log(`[stream] ${videoId}: ✅ client=${client} succeeded`);
        return result;
      }
    } catch (err) {
      console.error(`[stream] client=${client} failed for ${videoId}:`, err);
    }
  }

  console.error(`[stream] ${videoId}: all clients exhausted, no stream available`);
  return null;
}

export function getCookieStatus() {
  const envCookie = process.env.YT_COOKIES || "";
  const filePath = process.env.YT_COOKIES_FILE || "cookies.txt";
  const fileExists = existsSync(resolve(filePath));

  return {
    hasCookies: !!(envCookie || (fileExists && parseNetscapeCookieFile(resolve(filePath)))),
    envCookiePresent: !!envCookie,
    envCookieLength: envCookie.length,
    cookiesFile: filePath,
    cookiesFileExists: fileExists,
    visitorDataSet: !!process.env.YT_VISITOR_DATA,
  };
}
