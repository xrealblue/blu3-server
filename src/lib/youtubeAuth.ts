import { createHash } from "crypto";

export interface YoutubeAuth {
  cookieString: string;
  sapisid: string;
  visitorData: string;
}

let cachedAuth: YoutubeAuth | null = null;

export function parseCookies(cookieString: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of cookieString.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.substring(0, eq).trim();
    const val = part.substring(eq + 1).trim();
    result[key] = val;
  }
  return result;
}

function sha1(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

export function computeSapisidHash(sapisid: string, origin: string, timestamp?: number): string {
  const time = timestamp ?? Math.floor(Date.now() / 1000);
  const hash = sha1(`${time} ${sapisid} ${origin}`);
  return `${time}_${hash}`;
}

export function buildAuthHeaders(cookies: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const cookieParts: string[] = [];
  for (const [key, val] of Object.entries(cookies)) {
    cookieParts.push(`${key}=${val}`);
  }
  if (cookieParts.length > 0) {
    headers["Cookie"] = cookieParts.join("; ");
  }

  const sapisid = cookies["__Secure-3PAPISID"] || cookies["SAPISID"] || cookies["__Secure-1PAPISID"] || "";
  if (sapisid) {
    headers["Authorization"] = `SAPISIDHASH ${computeSapisidHash(sapisid, "https://www.youtube.com")}`;
  }

  headers["Origin"] = "https://www.youtube.com";
  headers["X-Origin"] = "https://www.youtube.com";

  return headers;
}

export function getVisitorData(cookies: Record<string, string>): string {
  const pref = cookies["PREF"] || "";
  for (const part of pref.split("&")) {
    const [k, v] = part.split("=");
    if (k === "f6") return v || "";
  }
  return cookies["VISITOR_INFO1_LIVE"] || "";
}

export async function initAuth(): Promise<YoutubeAuth> {
  if (cachedAuth) return cachedAuth;

  const cookieString = process.env.YT_COOKIES || "";
  const cookies = parseCookies(cookieString);
  const sapisid = cookies["__Secure-3PAPISID"] || cookies["SAPISID"] || cookies["__Secure-1PAPISID"] || "";
  const visitorData = getVisitorData(cookies);

  cachedAuth = { cookieString, sapisid, visitorData };
  return cachedAuth;
}

export function resetAuth(): void {
  cachedAuth = null;
}
