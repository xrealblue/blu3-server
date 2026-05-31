import { Innertube } from "youtubei.js";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

let innertube: Innertube | null = null;

function getCookieHeader(): string {
  if (process.env.YT_COOKIES) return process.env.YT_COOKIES;
  const jsonPath = resolve(process.cwd(), process.env.YT_COOKIES_FILE ?? "cookies.json");
  if (!existsSync(jsonPath)) return "";
  try {
    const raw = readFileSync(jsonPath, "utf8");
    const cookies: { name: string; value: string }[] = JSON.parse(raw);
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return "";
  }
}

async function getInnertube(): Promise<Innertube> {
  if (innertube) return innertube;
  innertube = await Innertube.create({
    cookie: getCookieHeader(),
  });
  return innertube;
}

async function extractWithYoutubei(videoId: string): Promise<string | null> {
  try {
    const yt = await getInnertube();
    const info = await yt.getInfo(videoId);
    const format = info.chooseFormat({ type: "audio", quality: "best" });
    if (format && format.url) return format.url;
    const formats = info.streaming_data?.adaptive_formats ?? [];
    const audioFormats = formats.filter(
      (f: any) => f.has_audio && !f.has_video,
    );
    audioFormats.sort((a: any, b: any) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
    for (const f of audioFormats) {
      if (f.url) return f.url;
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
      { encoding: "utf8", timeout: 20000, windowsHide: true },
    ).trim();
    return url || null;
  } catch {
    return null;
  }
}

export async function getAudioStreamUrl(videoId: string): Promise<string | null> {
  const fromDlp = extractWithYtdlp(videoId);
  if (fromDlp) return fromDlp;
  const fromYt = await extractWithYoutubei(videoId);
  return fromYt;
}
