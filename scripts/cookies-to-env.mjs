/**
 * Converts a JSON cookie array (from browser extensions like Get cookies.txt)
 * to a semicolon-separated cookie string for YT_COOKIES env var.
 *
 * Usage:
 *   node scripts/cookies-to-env.mjs < cookies.json
 *
 * Or pipe:
 *   cat cookies.json | node scripts/cookies-to-env.mjs >> .env
 */

const fs = await import("fs");

const input = await new Promise((resolve) => {
  let data = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => resolve(data));
});

let cookies;
try {
  cookies = JSON.parse(input);
} catch {
  console.error("Invalid JSON. Pipe an array of cookie objects.");
  process.exit(1);
}

if (!Array.isArray(cookies)) {
  console.error("Expected an array of cookie objects.");
  process.exit(1);
}

const parts = [];
for (const c of cookies) {
  if (c.domain && !c.domain.endsWith(".youtube.com") && c.domain !== "youtube.com") continue;
  const name = c.name;
  const value = c.value;
  if (!name || !value) continue;
  parts.push(`${name}=${value}`);
}

console.log(`YT_COOKIES=${parts.join("; ")}`);
