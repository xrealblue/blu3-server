import { Innertube, ClientType } from "youtubei.js";

const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

let ytInstance: Innertube | null = null;
let sessionCreatedAt = 0;
let sessionPromise: Promise<Innertube> | null = null;

async function signIn(yt: Innertube) {
  const refreshToken = process.env.YT_OAUTH_REFRESH_TOKEN;
  if (!refreshToken) return;

  const clientId = process.env.YT_OAUTH_CLIENT_ID;
  const clientSecret = process.env.YT_OAUTH_CLIENT_SECRET;

  const tokens: any = {
    access_token: process.env.YT_OAUTH_ACCESS_TOKEN || "placeholder",
    refresh_token: refreshToken,
    expiry_date: process.env.YT_OAUTH_EXPIRY_DATE || new Date(0).toISOString(),
  };
  if (clientId && clientSecret) {
    tokens.client = { client_id: clientId, client_secret: clientSecret };
  }
  await yt.session.signIn(tokens);
  yt.session.logged_in = true;
  console.log("[stream] OAuth sign-in complete");
}

async function createSession(): Promise<Innertube> {
  console.log("[stream] Creating TVHTML5 session...");
  const yt = await Innertube.create({
    client_type: ClientType.TV,
    generate_session_locally: true,
    retrieve_player: false,
    ...(process.env.YT_COOKIES ? { cookie: process.env.YT_COOKIES } : {}),
  });

  if (process.env.YT_OAUTH_REFRESH_TOKEN) {
    try {
      await signIn(yt);
    } catch (err: any) {
      console.error("[stream] OAuth sign-in failed:", err.message);
    }
  }

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

function val(obj: any, ...keys: string[]) {
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function pickBestFormat(formats: any[]): any | null {
  if (!formats.length) return null;
  const byBitrate = (a: any, b: any) => (val(b, "bitrate") ?? 0) - (val(a, "bitrate") ?? 0);
  const opus = formats.filter((f) => (val(f, "mimeType", "mime_type") || "").includes("opus")).sort(byBitrate);
  if (opus.length) return opus[0];
  const aac = formats.filter((f) => (val(f, "mimeType", "mime_type") || "").includes("mp4")).sort(byBitrate);
  if (aac.length) return aac[0];
  return formats.sort(byBitrate)[0];
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

    const raw = await yt.session.http.fetch("/player", {
      method: "POST",
      body: JSON.stringify({
        videoId,
        racyCheckOk: true,
        contentCheckOk: true,
        playbackContext: {
          contentPlaybackContext: {
            vis: 0,
            splay: false,
            lactMilliseconds: "-1",
          },
        },
      }),
      headers: { "Content-Type": "application/json" },
    });
    const data = await raw.json();

    if (!data.streamingData) {
      const status = data.playabilityStatus?.status;
      console.error(`[stream] ${videoId}: no streamingData, playability=${status}`);
      return null;
    }

    const adaptive = data.streamingData.adaptiveFormats || data.streamingData.adaptive_formats || [];
    const combined = data.streamingData.formats || [];

    const candidates: any[] = [];
    for (const f of adaptive) {
      const url = val(f, "url");
      const hasAudio = val(f, "hasAudio", "has_audio");
      const hasVideo = val(f, "hasVideo", "has_video");
      if (url && hasAudio && !hasVideo) {
        candidates.push(f);
      }
    }
    for (const f of combined) {
      const url = val(f, "url");
      const hasAudio = val(f, "hasAudio", "has_audio");
      if (url && hasAudio) {
        candidates.push(f);
      }
    }

    const picked = pickBestFormat(candidates);
    const pickedUrl = val(picked, "url");
    if (!picked || !pickedUrl) {
      console.error(`[stream] ${videoId}: no format with url found`);
      console.error(`[stream]   adaptive=${adaptive.length} combined=${combined.length}`);
      return null;
    }

    const itag = val(picked, "itag");
    const bitrate = val(picked, "bitrate");
    const mimeRaw = val(picked, "mimeType", "mime_type") || "audio/mp4";
    const contentLen = val(picked, "contentLength", "content_length");

    console.log(`[stream] ${videoId}: itag=${itag} bitrate=${bitrate} mime=${mimeRaw}`);
    return {
      url: pickedUrl,
      mimeType: mimeRaw,
      contentLength: contentLen != null ? String(contentLen) : null,
      bitrate: bitrate ?? null,
    };
  } catch (err: any) {
    console.error(`[stream] getStreamInfo error for ${videoId}:`, err.message);
    if (err.stack) console.error(err.stack.split("\n").slice(0, 5).join("\n"));
    return null;
  }
}
