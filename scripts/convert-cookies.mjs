#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, isAbsolute } from "path";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");

function loadEnvFiles(...paths) {
  const env = {};
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf-8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
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
  } catch {
    console.error("Failed to parse COOKIES_JSON");
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

const env = loadEnvFiles(
  resolve(PROJECT_ROOT, ".env"),
  resolve(PROJECT_ROOT, ".env.private"),
);

const cookiesJson = env.COOKIES_JSON;

if (!cookiesJson) {
  console.log("No COOKIES_JSON found. Skipping cookie generation.");
  process.exit(0);
}

const relativePath = env.YT_COOKIES_FILE || "./cookies.txt";
const cookiesPath = resolve(PROJECT_ROOT, relativePath);

const netscape = convertToNetscape(cookiesJson);
writeFileSync(cookiesPath, netscape, "utf-8");
console.log(`Wrote ${cookiesPath} (${(cookiesJson.length / 1024).toFixed(1)}KB JSON → ${(netscape.length / 1024).toFixed(1)}KB Netscape)`);
