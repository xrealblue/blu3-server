import { Innertube, FormatUtils } from "youtubei.js";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

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

export async function getAudioStreamUrl(videoId: string): Promise<{ url: string; mimeType: string } | null> {
  try {
    const yt = await getInstance();
    console.log(`[stream] fetching info for ${videoId}`);
    const info = await yt.getBasicInfo(videoId);

    if (!info.streaming_data) {
      console.error(`[stream] ${videoId}: no streaming_data — YouTube auth cookies may be missing or expired`);
      return null;
    }

    console.log(`[stream] ${videoId}: got streaming_data, choosing format`);
    const format = FormatUtils.chooseFormat({
      type: "audio",
      quality: "best",
      format: "any",
    }, info.streaming_data);

    if (!format) {
      console.error(`[stream] ${videoId}: chooseFormat returned no audio format`);
      return null;
    }

    let url: string | undefined;
    if (format.decipher) {
      console.log(`[stream] ${videoId}: deciphering URL`);
      const decipherUrl = await format.decipher(yt.session!.player);
      url = typeof decipherUrl === "string" ? decipherUrl : undefined;
    } else {
      url = (format as any).url;
    }

    if (!url) {
      console.error(`[stream] ${videoId}: no URL after decipher`);
      return null;
    }

    console.log(`[stream] ${videoId}: got CDN URL (${url.slice(0, 60)}...)`);
    return { url, mimeType: format.mime_type || "audio/webm" };
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
