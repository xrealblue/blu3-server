import { Redis } from "@upstash/redis";
import { env } from "node:process";

const redisUrl = env.UPSTASH_REDIS_REST_URL;
const redisToken = env.UPSTASH_REDIS_REST_TOKEN;

let redis: Redis | null = null;

export function getRedis(): Redis | null {
  if (!redisUrl || !redisToken) return null;
  if (!redis) {
    try {
      redis = new Redis({ url: redisUrl, token: redisToken });
    } catch {
      return null;
    }
  }
  return redis;
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    return (await r.get<T>(key)) ?? null;
  } catch {
    return null;
  }
}

export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds?: number,
): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    if (ttlSeconds) await r.setex(key, ttlSeconds, JSON.stringify(value));
    else await r.set(key, JSON.stringify(value));
  } catch {
    /* silently fail — in-memory fallback below handles it */
  }
}

export async function cacheDel(key: string): Promise<void> {
  const r = getRedis();
  if (!r) return;
  try {
    await r.del(key);
  } catch {
    /* ignore */
  }
}

/* ─── In-memory fallback ─────────────────────────────── */

const memCache = new Map<string, { data: unknown; expiresAt: number }>();
const MEM_TTL_MS = 30 * 60 * 1000;

export function memGet<T>(key: string): T | null {
  const entry = memCache.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    memCache.delete(key);
    return null;
  }
  return entry.data as T;
}

export function memSet(key: string, value: unknown, ttlMs = MEM_TTL_MS) {
  memCache.set(key, { data: value, expiresAt: Date.now() + ttlMs });
}

export function memDel(key: string) {
  memCache.delete(key);
}

/* ─── Unified cache (Redis primary, memory fallback) ─── */

export async function unifiedGet<T>(key: string): Promise<T | null> {
  const fromRedis = await cacheGet<T>(key);
  if (fromRedis !== null) return fromRedis;
  return memGet<T>(key);
}

export async function unifiedSet(
  key: string,
  value: unknown,
  ttlSeconds = 1800,
) {
  await cacheSet(key, value, ttlSeconds);
  memSet(key, value, ttlSeconds * 1000);
}

export async function unifiedDel(key: string) {
  await cacheDel(key);
  memDel(key);
}
