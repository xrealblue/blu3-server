import { Innertube } from "youtubei.js";
import { execSync } from "node:child_process";

let innertube: Innertube | null = null;

async function getInnertube(): Promise<Innertube> {
  if (innertube) return innertube;
  innertube = await Innertube.create({
    cookie: process.env.YT_COOKIES,
  });
  return innertube;
}

async function extractWithYoutubei(videoId: string): Promise<string | null> {
  try {
    const yt = await getInnertube();
    const info = await yt.getInfo(videoId);
    const format = info.chooseFormat({ type: "audio", quality: "best" });
    if (format && format.url) return format.url;
    const adaptive = info.adaptive_formats?.filter((f) => f.has_audio && !f.has_video) ?? [];
    const sorted = adaptive.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
    for (const f of sorted) {
      if (f.url) return f.url;
      if (f.decipher) continue;
    }
    return null;
  } catch {
    return null;
  }
}

function extractWithYtdlp(videoId: string): string | null {
  try {
    const url = execSync(
      `yt-dlp -g -f "bestaudio[ext=m4a]/bestaudio" --no-warnings ${videoId}`,
      { encoding: "utf8", timeout: 15000, windowsHide: true },
    ).trim();
    return url || null;
  } catch {
    return null;
  }
}

export async function getAudioStreamUrl(videoId: string): Promise<string | null> {
  const fromYt = await extractWithYoutubei(videoId);
  if (fromYt) return fromYt;
  const fromDlp = extractWithYtdlp(videoId);
  return fromDlp;
}
