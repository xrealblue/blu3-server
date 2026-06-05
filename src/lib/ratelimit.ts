import { getRedis } from "./redis.js";

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  reset: number;
}

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 30;

export async function checkRateLimit(
  identifier: string,
  maxRequests: number = MAX_REQUESTS,
  windowMs: number = WINDOW_MS,
): Promise<RateLimitResult> {
  const r = getRedis();
  if (!r) return { success: true, remaining: 999, reset: 0 };

  const key = `ratelimit:${identifier}`;
  const now = Date.now();
  const windowStart = now - windowMs;

  try {
    const cleaned = await r.zremrangebyscore(key, 0, windowStart);
    const count = await r.zcard(key);
    if (count >= maxRequests) {
      const oldest = await r.zrange(key, 0, 0, { withScores: true });
      const reset = oldest.length >= 2 ? Number(oldest[1]) + windowMs - now : windowMs;
      return { success: false, remaining: 0, reset };
    }
    await r.zadd(key, { score: now, member: `${now}:${Math.random()}` });
    await r.expire(key, Math.ceil(windowMs / 1000));
    return { success: true, remaining: maxRequests - count - 1, reset: 0 };
  } catch (err) {
    console.error("[RateLimit] error:", err);
    return { success: true, remaining: 1, reset: 0 };
  }
}
