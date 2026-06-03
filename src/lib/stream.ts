import { Innertube, FormatUtils, Platform } from "youtubei.js";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

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

async function getInstance(): Promise<Innertube> {
  const now = Date.now();
  if (ytInstance && now - lastInit < INIT_TTL) return ytInstance;

  const cookie = getCookies();
  const visitorData = process.env.YT_VISITOR_DATA || "";

  ytInstance = await Innertube.create({
    cookie: cookie || undefined,
    visitor_data: visitorData || undefined,
  });

  lastInit = Date.now();
  return ytInstance;
}

async function decipherFormat(
  format: any,
  player: any,
): Promise<string | undefined> {
  if (format.url) return format.url;
  if (format.signature_cipher || format.cipher) {
    const result = await format.decipher(player);
    return typeof result === "string" ? result : undefined;
  }
  return undefined;
}

export async function getAudioStreamUrl(videoId: string): Promise<{ url: string; mimeType: string } | null> {
  try {
    const yt = await getInstance();
    console.log(`[stream] fetching info for ${videoId}`);
    const info = await yt.getBasicInfo(videoId);

    if (!info.streaming_data) {
      console.error(`[stream] ${videoId}: no streaming_data — YouTube auth cookies may be missing or expired`);
      return null;
    }

    const formats = [
      ...(info.streaming_data.formats || []),
      ...(info.streaming_data.adaptive_formats || []),
    ];

    // 1) Try chooseFormat for best audio
    try {
      const audioFormat = FormatUtils.chooseFormat({ type: "audio", quality: "best", format: "any" }, info.streaming_data);
      const url = await decipherFormat(audioFormat, yt.session!.player);
      if (url) {
        console.log(`[stream] ${videoId}: audio-only format itag=${audioFormat.itag}`);
        return { url, mimeType: sanitizeMimeType(audioFormat.mime_type || "audio/webm") };
      }
    } catch {
      // fall through
    }

    // 2) Search all formats for one with audio + URL data
    for (const f of formats) {
      if (f.has_audio) {
        const url = await decipherFormat(f, yt.session!.player);
        if (url) {
          console.log(`[stream] ${videoId}: found audio format itag=${f.itag} via fallback search`);
          return { url, mimeType: sanitizeMimeType(f.mime_type || "audio/webm") };
        }
      }
    }

    // 3) Last resort: any format with cipher data (combined video+audio → client extracts audio)
    for (const f of formats) {
      if (f.signature_cipher || f.cipher || f.url) {
        const url = await decipherFormat(f, yt.session!.player);
        if (url) {
          console.log(`[stream] ${videoId}: using combined format itag=${f.itag} (audio extracted on client)`);
          return { url, mimeType: sanitizeMimeType(f.mime_type || "audio/mp4") };
        }
      }
    }

    console.error(`[stream] ${videoId}: no playable format found`);
    return null;
  } catch (err) {
    console.error(`[stream] getAudioStreamUrl failed for ${videoId}:`, err);
    return null;
  }
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
