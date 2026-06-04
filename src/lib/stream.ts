import { Innertube, ClientType } from "youtubei.js";

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

const ANDROID_API_KEY = "AIzaSyA8eiZmM1G6r9z-4U6B4M4h9Q9v_1X8X3c";

let ytInstance: Innertube | null = null;
let sessionCreatedAt = 0;
let sessionPromise: Promise<Innertube> | null = null;

async function createSession(): Promise<Innertube> {
  console.log("[stream] Creating ANDROID session...");
  const yt = await Innertube.create({
    client_type: ClientType.ANDROID,
    generate_session_locally: true,
    retrieve_player: false,
    ...(process.env.YT_COOKIES ? { cookie: process.env.YT_COOKIES } : {}),
  });
  // ANDROID client needs the correct API key — the locally generated session
  // uses the WEB key (AIzaSyAO_F...) which YouTube rejects with 400.
  yt.session.api_key = ANDROID_API_KEY;
  console.log("[stream] Session ready, client:", yt.session.context?.client?.clientName);
  return yt;
}

async function getSession(): Promise<Innertube> {
  const now = Date.now();
  if (ytInstance && now - sessionCreatedAt < SESSION_TTL_MS) return ytInstance;
  if (sessionPromise) return sessionPromise;
  sessionPromise = createSession()
    .then((yt) => {
      ytInstance = yt;
      sessionCreatedAt = Date.now();
      sessionPromise = null;
      return yt;
    })
    .catch((err) => {
      sessionPromise = null;
      throw err;
    });
  return sessionPromise;
}

getSession().catch((err) => console.warn("[stream] Pre-warm failed:", err.message));

interface AudioFormat {
  url?: string | null;
  mime_type?: string;
  has_video?: boolean;
  has_audio?: boolean;
  bitrate?: number;
  content_length?: number;
}

function pickBestAudio(formats: AudioFormat[]): AudioFormat | null {
  const audioOnly = formats.filter((f) => f.url && !f.has_video && f.has_audio);
  if (!audioOnly.length) return null;
  const byBitrate = (a: AudioFormat, b: AudioFormat) => (b.bitrate ?? 0) - (a.bitrate ?? 0);
  const opus = audioOnly.filter((f) => f.mime_type?.includes("opus")).sort(byBitrate);
  if (opus.length) return opus[0];
  const aac = audioOnly.filter((f) => f.mime_type?.includes("mp4")).sort(byBitrate);
  if (aac.length) return aac[0];
  return audioOnly.sort(byBitrate)[0];
}

export interface StreamInfo {
  url: string;
  mimeType: string;
  contentLength: string | null;
  bitrate: number | null;
}

export async function getStreamInfo(videoId: string): Promise<StreamInfo | null> {
  try {
    const yt = await getSession();
    let url: string | null = null;
    let mimeType = "audio/webm";
    let contentLength: string | null = null;
    let bitrate: number | null = null;

    try {
      const format = await yt.getStreamingData(videoId, {
        type: "audio",
        quality: "best",
        format: "any",
      });
      if (format.url) {
        url = format.url;
        mimeType = format.mime_type || mimeType;
        contentLength = format.content_length != null ? String(format.content_length) : null;
        bitrate = format.bitrate ?? null;
      }
    } catch (e: any) {
      console.warn(`[stream] getStreamingData failed for ${videoId}:`, e.message);
    }

    if (!url) {
      const info = await yt.getBasicInfo(videoId);
      const allFormats = [
        ...(info.streaming_data?.formats || []),
        ...(info.streaming_data?.adaptive_formats || []),
      ];
      const picked = pickBestAudio(allFormats as any);
      if (!picked?.url) {
        console.error(`[stream] no audio URL for ${videoId}`);
        return null;
      }
      url = picked.url;
      mimeType = picked.mime_type || mimeType;
      contentLength = picked.content_length != null ? String(picked.content_length) : null;
      bitrate = picked.bitrate ?? null;
    }

    return { url, mimeType, contentLength, bitrate };
  } catch (err: any) {
    console.error(`[stream] getStreamInfo error for ${videoId}:`, err.message);
    if (err.stack) console.error(err.stack.split("\n").slice(0, 5).join("\n"));
    return null;
  }
}
