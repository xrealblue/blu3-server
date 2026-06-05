#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, isAbsolute, dirname } from "path";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");

function loadEnvFiles(...paths) {
  const env = {};
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf-8");
    let readingCookies = false;
    let cookiesBuffer = "";
    const setCookie = (env, key, raw) => {
      let val = raw.trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      env[key] = val;
    };
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (readingCookies) {
        readingCookies = !trimmed.endsWith('"') && !trimmed.endsWith("'");
        if (!readingCookies) {
          setCookie(env, "COOKIES_JSON", cookiesBuffer + "\n" + trimmed);
          cookiesBuffer = "";
        } else {
          cookiesBuffer += "\n" + trimmed;
        }
        continue;
      }
      const cookiesIdx = trimmed.indexOf("COOKIES_JSON=");
      if (cookiesIdx === 0) {
        const afterEq = trimmed.slice("COOKIES_JSON=".length);
        if ((afterEq.startsWith('"') && afterEq.endsWith('"')) || (afterEq.startsWith("'") && afterEq.endsWith("'"))) {
          setCookie(env, "COOKIES_JSON", afterEq);
        } else if (afterEq.startsWith('"') || afterEq.startsWith("'")) {
          readingCookies = true;
          cookiesBuffer = afterEq;
        } else {
          setCookie(env, "COOKIES_JSON", afterEq);
        }
        continue;
      }
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      if (key === "COOKIES_JSON") continue;
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      env[key] = val;
    }
  }
  return env;
}

function convertToNetscape(jsonStr) {
  let cookies;
  try {
    cookies = JSON.parse(jsonStr);
  } catch (e) {
    console.error("Failed to parse COOKIES_JSON as JSON:", e.message);
    console.error("First 200 chars:", jsonStr.slice(0, 200));
    process.exit(1);
  }
  if (!Array.isArray(cookies)) {
    console.error("COOKIES_JSON must be a JSON array of cookie objects");
    process.exit(1);
  }

  const lines = [
    "# Netscape HTTP Cookie File",
    "# https://curl.haxx.se/rfc/cookie_spec.html",
    "# This file is auto-generated. Do not edit manually.",
    "",
  ];

  for (const c of cookies) {
    const domain = c.domain || "";
    const domainFlag = domain.startsWith(".") ? "TRUE" : "FALSE";
    const path = c.path || "/";
    const secure = c.secure ? "TRUE" : "FALSE";
    const expiry = Math.floor(c.expirationDate || 2147483647);
    const name = c.name || "";
    const value = c.value || "";
    lines.push(
      [domain, domainFlag, path, secure, expiry, name, value].join("\t"),
    );
  }

  return lines.join("\n") + "\n";
}

// Support direct file argument: bun scripts/convert-cookies.mjs ./cookies_input.json
const fileArg = process.argv[2];
if (fileArg) {
  const filePath = resolve(process.cwd(), fileArg);
  if (!existsSync(filePath)) {
    console.error("File not found:", filePath);
    process.exit(1);
  }
  const jsonStr = readFileSync(filePath, "utf-8").trim();
  const relativePath = process.env.YT_COOKIES_FILE || "./cookies.txt";
  const cookiesPath = resolve(PROJECT_ROOT, relativePath);
  const netscape = convertToNetscape(jsonStr);
  writeFileSync(cookiesPath, netscape, "utf-8");
  console.log(`Wrote ${cookiesPath} (${(netscape.length / 1024).toFixed(1)}KB)`);
  process.exit(0);
}

const env = loadEnvFiles(
  resolve(PROJECT_ROOT, ".env"),
  resolve(PROJECT_ROOT, ".env.private"),
);

const cookiesJson = env.COOKIES_JSON;

if (!cookiesJson) {
  console.log("No COOKIES_JSON found in .env or .env.private.");
  console.log("Usage:");
  console.log("  bun scripts/convert-cookies.mjs           # from COOKIES_JSON env var");
  console.log("  bun scripts/convert-cookies.mjs ./input.json  # from file");
  process.exit(0);
}

const relativePath = env.YT_COOKIES_FILE || "./cookies.txt";
const cookiesPath = resolve(PROJECT_ROOT, relativePath);

const netscape = convertToNetscape(cookiesJson);
writeFileSync(cookiesPath, netscape, "utf-8");
console.log(`Wrote ${cookiesPath} (${(netscape.length / 1024).toFixed(1)}KB)`);
