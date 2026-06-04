import { Innertube, Platform } from "youtubei.js";

Platform.load({
  ...Platform.shim,
  eval: (data: any, env: any) => {
    const keys = Object.keys(env);
    const values = keys.map((k: string) => env[k]);
    return new Function(...keys, data.output)(...values);
  },
});

let ytInstance: Innertube | null = null;

async function getYtInstance(): Promise<Innertube> {
  if (!ytInstance) {
    ytInstance = await Innertube.create({
      cookie: process.env.YT_COOKIES || "",
    });
  }
  return ytInstance;
}

export async function getStreamUrl(videoId: string): Promise<string | null> {
  try {
    const yt = await getYtInstance();
    const info = await yt.getBasicInfo(videoId);
    const streamingData = info.streaming_data;
    if (!streamingData) {
      console.error(`[stream] no streaming_data for ${videoId}`);
      return null;
    }

    const formats = [
      ...(streamingData.formats || []),
      ...(streamingData.adaptive_formats || []),
    ];

    const audioFormats = formats.filter(
      (f: any) => f.has_audio && !f.has_video,
    );
    audioFormats.sort(
      (a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0),
    );

    for (const f of audioFormats) {
      let url: string | null = (f as any).url || null;
      if (!url) {
        try {
          url = (await (f as any).decipher(yt.session!.player)) as string;
        } catch {}
      }
      if (url) return url;
    }

    console.error(`[stream] no decipherable audio URL for ${videoId}`);
    return null;
  } catch (err: any) {
    console.error(`[stream] getStreamUrl error for ${videoId}:`, err.message);
    return null;
  }
}
