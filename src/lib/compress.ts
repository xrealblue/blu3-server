import { gzipSync, gunzipSync } from "node:zlib";

const COMPRESS_THRESHOLD = 1024;
const PREFIX = "BZ:";

export function maybeCompress(data: string): string {
  if (data.length < COMPRESS_THRESHOLD) return data;
  try {
    const compressed = gzipSync(Buffer.from(data, "utf-8"));
    return PREFIX + compressed.toString("base64");
  } catch {
    return data;
  }
}

export function maybeDecompress(data: string): string {
  if (!data.startsWith(PREFIX)) return data;
  try {
    const base64 = data.slice(PREFIX.length);
    const decompressed = gunzipSync(Buffer.from(base64, "base64"));
    return decompressed.toString("utf-8");
  } catch {
    return data;
  }
}
