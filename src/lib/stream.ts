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
    console.log(`[stream] got innertube instance, fetching ${videoId}`);
    const info = await yt.getBasicInfo(videoId);
    const streamingData = info.streaming_data;
    if (!streamingData) {
      console.error(`[stream] no streaming_data for ${videoId} — keys: ${Object.keys(info).join(",")}`);
      return null;
    }

    const formats = [
      ...(streamingData.formats || []),
      ...(streamingData.adaptive_formats || []),
    ];
    console.log(`[stream] ${videoId}: ${formats.length} total formats`);

    const audioFormats = formats.filter(
      (f: any) => f.has_audio && !f.has_video,
    );
    console.log(`[stream] ${videoId}: ${audioFormats.length} audio-only formats`);
    audioFormats.sort(
      (a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0),
    );

    for (const f of audioFormats) {
      let url: string | null = (f as any).url || null;
      if (!url) {
        console.log(`[stream] format ${(f as any).itag}: no direct URL, trying decipher`);
        try {
          url = (await (f as any).decipher(yt.session!.player)) as string;
          console.log(`[stream] format ${(f as any).itag}: decipher succeeded`);
        } catch (e: any) {
          console.error(`[stream] format ${(f as any).itag}: decipher failed: ${e.message}`);
        }
      } else {
        console.log(`[stream] format ${(f as any).itag}: has direct URL`);
      }
      if (url) return url;
    }

    console.error(`[stream] no decipherable audio URL for ${videoId}`);
    return null;
  } catch (err: any) {
    console.error(`[stream] getStreamUrl error for ${videoId}:`, err.message);
    if (err.stack) console.error(`[stream] stack:`, err.stack.split("\n").slice(0, 5).join("\n"));
    return null;
  }
}
