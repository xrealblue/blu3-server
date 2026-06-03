import { Innertube, FormatUtils } from "youtubei.js";

let ytInstance: Innertube | null = null;
let lastInit = 0;
const INIT_TTL = 1000 * 60 * 30;

async function getInstance(): Promise<Innertube> {
  const now = Date.now();
  if (ytInstance && now - lastInit < INIT_TTL) return ytInstance;

  const cookie = process.env.YT_COOKIES || "";
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
    const info = await yt.getBasicInfo(videoId);

    if (!info.streaming_data) return null;

    const format = FormatUtils.chooseFormat(info.streaming_data, {
      type: "audio",
      quality: "best",
      format: "any",
    });

    if (!format) return null;

    const url = format.decipher?.(yt.session?.player) || (format as any).url;
    if (!url) return null;

    return { url, mimeType: format.mime_type || "audio/webm" };
  } catch (err) {
    console.error(`getAudioStreamUrl failed for ${videoId}:`, err);
    return null;
  }
}

export function getCookieStatus() {
  return {
    streamExtraction: "enabled",
    using: "youtubei.js direct CDN audio extraction",
  };
}
