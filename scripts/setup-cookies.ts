import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

interface Cookie {
  domain: string;
  hostOnly?: boolean;
  httpOnly?: boolean;
  name: string;
  path: string;
  sameSite?: string;
  secure: boolean;
  session?: boolean;
  value: string;
  expirationDate?: number;
}

function getSourcePath(): string {
  return process.env.YT_COOKIES_FILE
    ? resolve(ROOT, process.env.YT_COOKIES_FILE)
    : resolve(ROOT, "cookies.json");
}

function getOutputPath(): string {
  return resolve(ROOT, "cookies.txt");
}

function parseCookies(jsonPath: string): Cookie[] {
  const raw = readFileSync(jsonPath, "utf8");
  return JSON.parse(raw) as Cookie[];
}

function toNetscapeLine(c: Cookie): string {
  const domain = c.domain.startsWith(".") ? c.domain : c.domain;
  const domainFlag = domain.startsWith(".") ? "TRUE" : "FALSE";
  const path = c.path || "/";
  const secure = c.secure ? "TRUE" : "FALSE";
  const expiry = c.expirationDate
    ? Math.floor(c.expirationDate).toString()
    : "0";
  const name = c.name;
  const value = c.value;
  return `${domain}\t${domainFlag}\t${path}\t${secure}\t${expiry}\t${name}\t${value}`;
}

function toHeaderString(cookies: Cookie[]): string {
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

export function getCookieHeader(): string {
  const jsonPath = getSourcePath();
  if (!existsSync(jsonPath)) return process.env.YT_COOKIES ?? "";
  const cookies = parseCookies(jsonPath);
  return toHeaderString(cookies);
}

function writeNetscapeFile(cookies: Cookie[], outputPath: string): void {
  const lines = [
    "# Netscape HTTP Cookie File",
    "# https://curl.haxx.se/rfc/cookie_spec.html",
    "# This file is auto-generated from cookies.json. Do not edit.",
    "",
    ...cookies.map(toNetscapeLine),
    "",
  ];
  writeFileSync(outputPath, lines.join("\n"), "utf8");
}

function main(): void {
  const jsonPath = getSourcePath();
  if (!existsSync(jsonPath)) {
    const alt = resolve(ROOT, "cookies.json");
    if (existsSync(alt)) {
      process.env.YT_COOKIES_FILE = "./cookies.json";
      main();
      return;
    }
    console.warn("[setup-cookies] cookies.json not found. Skipping.");
    return;
  }
  try {
    const cookies = parseCookies(jsonPath as string);
    const outputPath = getOutputPath();
    writeNetscapeFile(cookies, outputPath);
    const header = toHeaderString(cookies);
    if (!process.env.YT_COOKIES) {
      process.env.YT_COOKIES = header;
    }
    console.log(`[setup-cookies] Wrote ${outputPath} (${cookies.length} cookies)`);
  } catch (err) {
    console.error("[setup-cookies] Failed:", err);
  }
}

main();
