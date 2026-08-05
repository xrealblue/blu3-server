import { Redis } from "@upstash/redis";
import { env } from "node:process";

const redisUrl = env.UPSTASH_REDIS_REST_URL;
const redisToken = env.UPSTASH_REDIS_REST_TOKEN;

let redis: Redis | null = null;

export function getRedis(): Redis | null {
  if (!redisUrl || !redisToken) return null;
  if (!redis) {
    redis = new Redis({ url: redisUrl, token: redisToken });
  }
  return redis;
}
