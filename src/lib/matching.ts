export function normalizeStr(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ").trim();
}

export function isDurationMatchMs(actualMs: number, expectedMs: number | undefined): boolean {
  if (!expectedMs || !actualMs) return true;
  return Math.abs(actualMs - expectedMs) < 3000;
}

export function upscaleJioImage(url: string): string {
  if (!url) return url;
  return url
    .replace("150x150", "500x500")
    .replace("50x50", "500x500")
    .replace("1080x1080", "500x500");
}
