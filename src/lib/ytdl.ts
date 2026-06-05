import { exec } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";

const execAsync = promisify(exec);

const CACHE = new Map<string, { url: string; fetchedAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000;

function getCookiesArg(): string {
  const cookiesPath = process.env.YT_COOKIES_FILE;
  if (cookiesPath && existsSync(cookiesPath)) {
    return `--cookies "${cookiesPath}"`;
  }
  return "";
}

export async function getAudioUrl(videoId: string): Promise<string | null> {
  const cached = CACHE.get(videoId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.url;
  }

  try {
    const cookiesArg = getCookiesArg();
    const { stdout } = await execAsync(
      `yt-dlp --get-url -f "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio" --no-warnings --no-playlist ${cookiesArg} "${videoId}"`,
      { timeout: 10000 },
    );
    const url = stdout.trim();
    if (!url) return null;

    CACHE.set(videoId, { url, fetchedAt: Date.now() });
    return url;
  } catch (err: any) {
    console.error(`[ytdl] ${videoId}:`, err.stderr?.trim() || err.message);
    return null;
  }
}
