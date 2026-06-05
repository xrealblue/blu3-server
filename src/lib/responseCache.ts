const responseCache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 3000;

export function getCached(key: string) {
  const entry = responseCache.get(key);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
    return entry.data;
  }
  return null;
}

export function setCache(key: string, data: any) {
  responseCache.set(key, { data, timestamp: Date.now() });
}

export function invalidateCache(key: string) {
  responseCache.delete(key);
}
