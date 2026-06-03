import { Innertube, FormatUtils, Platform } from "youtubei.js";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

const CLIENTS = ["TV_EMBEDDED", "ANDROID", "ANDROID_VR", "WEB"] as const;

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

async function tryClients(
  videoId: string,
  clients: Array<{ label: string; clientType?: string }>,
  withCookies: boolean,
): Promise<{ url: string; mimeType: string } | null> {
  for (const { label, clientType } of clients) {
    console.log(`[stream] fetching info for ${videoId} (client=${label}, cookies=${withCookies})`);
    try {
      const config: Record<string, unknown> = {
        visitor_data: process.env.YT_VISITOR_DATA || undefined,
      };
      if (withCookies) {
        config.cookie = getCookies() || undefined;
      }
      if (clientType) {
        config.client_type = clientType;
      }
      const yt = await Innertube.create(config);
      const info = await yt.getBasicInfo(videoId);
      const result = await extractFromInfo(videoId, info, yt.session!.player, label);
      if (result) {
        console.log(`[stream] ${videoId}: ✅ client=${label} succeeded`);
        return result;
      }
    } catch (err) {
      console.error(`[stream] client=${label} failed for ${videoId}:`, err);
    }
  }
  return null;
}

export async function getAudioStreamUrl(videoId: string): Promise<{ url: string; mimeType: string } | null> {
  // Pass 1: try with cookies (works if cookies are fresh)
  const withCookieClients = [
    { label: "default" },
    ...CLIENTS.map((c) => ({ label: c, clientType: c })),
  ];
  const result1 = await tryClients(videoId, withCookieClients, true);
  if (result1) return result1;

  // Pass 2: try without cookies on Oracle's clean IP (cookies expired workaround)
  console.log(`[stream] ${videoId}: cookies failed, retrying without cookies`);
  const noCookieClients = [
    { label: "default_no_cookies" },
    ...CLIENTS.map((c) => ({ label: `${c}_no_cookies`, clientType: c })),
  ];
  const result2 = await tryClients(videoId, noCookieClients, false);
  if (result2) return result2;

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
