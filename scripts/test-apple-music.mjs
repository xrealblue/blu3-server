// Standalone test script for Apple Music playlist import via AMP API
// Run: node scripts/test-apple-music.mjs

const PLAYLIST_URL = "https://music.apple.com/in/playlist/2000s-bollywood-essentials/pl.f55c6379d8cc475fb96bfeecb5d554a7";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function parseAppleMusicURL(url) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const playlistIdx = segments.findIndex(s => s === "playlist");
    if (playlistIdx < 1 || playlistIdx >= segments.length - 1) return null;
    return {
      storefront: segments[playlistIdx - 1],
      playlistId: segments[segments.length - 1],
    };
  } catch {
    return null;
  }
}

async function step1_parseUrl() {
  console.log("\n=== Step 1: Parse URL ===");
  const parts = parseAppleMusicURL(PLAYLIST_URL);
  if (!parts) {
    console.log("FAIL: Could not parse URL");
    return null;
  }
  console.log(`OK: storefront="${parts.storefront}", playlistId="${parts.playlistId}"`);
  return parts;
}

async function step2_fetchPage() {
  console.log("\n=== Step 2: Fetch beta.music.apple.com ===");
  const res = await fetch("https://beta.music.apple.com", {
    headers: { "User-Agent": UA }
  });
  if (!res.ok) {
    console.log(`FAIL: HTTP ${res.status}`);
    return null;
  }
  const html = await res.text();
  console.log(`OK: HTML length = ${html.length}`);

  const jsUri = html.match(/\/assets\/index-legacy[~-][^/]+\.js/)?.[0];
  if (!jsUri) {
    console.log("FAIL: Could not find index-legacy JS bundle in HTML");
    // List what we found
    const scripts = [...html.matchAll(/(\/assets\/[^"]+\.js)/g)].map(m => m[1]);
    console.log("Found JS bundles:", scripts.join(", "));
    return null;
  }
  console.log(`OK: Found JS bundle: ${jsUri}`);
  return jsUri;
}

async function step3_extractToken(jsUri) {
  console.log("\n=== Step 3: Extract JWT from JS bundle ===");
  console.log(`Fetching: https://beta.music.apple.com${jsUri}`);
  const res = await fetch(`https://beta.music.apple.com${jsUri}`, {
    headers: { "User-Agent": UA }
  });
  if (!res.ok) {
    console.log(`FAIL: HTTP ${res.status}`);
    return null;
  }
  const js = await res.text();
  console.log(`OK: JS length = ${js.length}`);

  // Try to find token in string literals
  let match = js.match(/['`"](eyJ[a-zA-Z0-9_-]+?\.[a-zA-Z0-9_-]+?\.[a-zA-Z0-9_-]+)['`"]/);
  if (!match) {
    // Fallback: try without quotes
    match = js.match(/(eyJ[a-zA-Z0-9_-]+?\.[a-zA-Z0-9_-]+?\.[a-zA-Z0-9_-]+)/);
  }
  if (!match) {
    console.log("FAIL: No JWT token found in JS bundle");
    return null;
  }

  const token = match[1];
  // Decode payload to verify
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  console.log(`OK: Token found (${token.length} chars)`);
  console.log(`    iss: ${payload.iss}, exp: ${new Date(payload.exp * 1000).toISOString()}`);
  return token;
}

async function step4_fetchPlaylist(token, parts) {
  console.log("\n=== Step 4: Fetch playlist from AMP API ===");
  const apiUrl = `https://amp-api.music.apple.com/v1/catalog/${parts.storefront}/playlists/${parts.playlistId}?include=tracks`;
  console.log(`GET ${apiUrl}`);

  const res = await fetch(apiUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: "https://music.apple.com",
      "User-Agent": UA,
    }
  });
  if (!res.ok) {
    const text = await res.text();
    console.log(`FAIL: HTTP ${res.status} - ${text.slice(0, 500)}`);
    return null;
  }

  const data = await res.json();
  const playlist = data?.data?.[0];
  if (!playlist) {
    console.log("FAIL: No playlist data in response");
    console.log("Response:", JSON.stringify(data).slice(0, 500));
    return null;
  }

  const name = playlist.attributes?.name || "Unknown";
  const tracks = (playlist.relationships?.tracks?.data || [])
    .filter(item => item.type === "songs")
    .map(item => ({
      trackName: item.attributes?.name || "Unknown Track",
      artistName: item.attributes?.artistName || "Unknown Artist",
    }));

  console.log(`OK: Playlist "${name}" with ${tracks.length} tracks`);
  console.log("\nFirst 10 tracks:");
  tracks.slice(0, 10).forEach((t, i) => {
    console.log(`  ${i + 1}. ${t.trackName} - ${t.artistName}`);
  });

  return { name, tracks };
}

async function main() {
  console.log("==============================================");
  console.log("Apple Music AMP API Test");
  console.log(`URL: ${PLAYLIST_URL}`);
  console.log("==============================================");

  const parts = await step1_parseUrl();
  if (!parts) process.exit(1);

  const jsUri = await step2_fetchPage();
  if (!jsUri) process.exit(1);

  const token = await step3_extractToken(jsUri);
  if (!token) process.exit(1);

  const result = await step4_fetchPlaylist(token, parts);
  if (!result) process.exit(1);

  console.log("\n==============================================");
  console.log("SUCCESS: All steps passed!");
  console.log(`Playlist: ${result.name}`);
  console.log(`Tracks: ${result.tracks.length}`);
  console.log("==============================================");
}

main().catch(err => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
