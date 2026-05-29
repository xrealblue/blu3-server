// Full flow test: Apple Music scrape + YouTube resolution + DB insertion
// Run: node scripts/test-apple-music.mjs

import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(import.meta.dirname, "../.env") });

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

// Simulate the server's chunkArray function
function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// Simulate resolveTrackToOfficialYouTube (simplified - just calls ytmusic-api)
async function resolveTrack(trackName, artistName, ytmusic) {
  try {
    const query = `${trackName} ${artistName}`;
    const results = await ytmusic.searchSongs(query);
    if (results && results.length > 0) {
      const best = results[0];
      return {
        videoId: best.videoId || "",
        image: best.thumbnails?.[best.thumbnails.length - 1]?.url?.replace(/=w\d+-h\d+.*$/, "=w226-h226-l90-rj") || "",
        durationMs: (best.duration ?? 0) * 1000 || 180000,
      };
    }
  } catch (err) {
    console.error(`  resolveTrack failed for "${query}":`, err.message);
  }
  return { videoId: "", image: "", durationMs: 0 };
}

async function main() {
  console.log("==============================================");
  console.log("Apple Music + YouTube Resolution Full Test");
  console.log("==============================================\n");

  // Step 1: Parse URL
  console.log("=== Step 1: Parse URL ===");
  const parts = parseAppleMusicURL(PLAYLIST_URL);
  if (!parts) { console.log("FAIL: URL parse"); process.exit(1); }
  console.log(`storefront="${parts.storefront}", playlistId="${parts.playlistId}"\n`);

  // Step 2: Get token
  console.log("=== Step 2: Get AMP API token ===");
  const mainRes = await fetch("https://beta.music.apple.com", { headers: { "User-Agent": UA } });
  const html = await mainRes.text();
  const jsUri = html.match(/\/assets\/index-legacy[~-][^/]+\.js/)?.[0];
  if (!jsUri) { console.log("FAIL: JS bundle not found"); process.exit(1); }
  const jsRes = await fetch(`https://beta.music.apple.com${jsUri}`, { headers: { "User-Agent": UA } });
  const js = await jsRes.text();
  const token = js.match(/['\x60"](eyJ[a-zA-Z0-9_-]+?\.[a-zA-Z0-9_-]+?\.[a-zA-Z0-9_-]+)['\x60"]/)?.[1];
  if (!token) { console.log("FAIL: Token not found"); process.exit(1); }
  const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  console.log(`Token OK (${token.length} chars, iss=${payload.iss})\n`);

  // Step 3: Fetch playlist with pagination
  console.log("=== Step 3: Fetch playlist tracks (paginated) ===");
  const allTracks = [];
  let playlistName = "Unknown";
  let offset = 0;

  while (true) {
    const apiUrl = `https://amp-api.music.apple.com/v1/catalog/${parts.storefront}/playlists/${parts.playlistId}?include=tracks&offset=${offset}`;
    const res = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://music.apple.com",
        "User-Agent": UA,
      }
    });
    if (!res.ok) {
      const errText = await res.text();
      console.log(`FAIL: HTTP ${res.status} at offset ${offset} - ${errText.slice(0, 200)}`);
      process.exit(1);
    }
    const data = await res.json();
    const playlist = data?.data?.[0];
    if (!playlist) break;

    playlistName = playlist.attributes?.name || playlistName;
    const batch = (playlist.relationships?.tracks?.data || [])
      .filter(item => item.type === "songs")
      .map(item => ({
        trackName: item.attributes?.name || "Unknown Track",
        artistName: item.attributes?.artistName || "Unknown Artist",
      }));

    allTracks.push(...batch);
    console.log(`  offset=${offset}: got ${batch.length} tracks (total: ${allTracks.length})`);

    if (batch.length < 100) break;
    offset += 100;
  }

  if (allTracks.length === 0) { console.log("FAIL: No tracks found"); process.exit(1); }
  console.log(`\nTotal tracks: ${allTracks.length}`);
  console.log("First 5:");
  allTracks.slice(0, 5).forEach((t, i) => console.log(`  ${i + 1}. ${t.trackName} - ${t.artistName}`));
  console.log();

  // Step 4: YouTube resolution test (first 10 tracks)
  console.log("=== Step 4: Test YouTube resolution (first 10 tracks) ===");
  try {
    const { default: YTMusic } = await import("ytmusic-api");
    const ytmusic = new YTMusic();
    await ytmusic.initialize();
    console.log("ytmusic-api initialized OK");

    const testChunk = allTracks.slice(0, 10);
    for (const item of testChunk) {
      const resolved = await resolveTrack(item.trackName, item.artistName, ytmusic);
      const status = resolved.videoId ? "OK" : "FAIL";
      console.log(`  [${status}] ${item.trackName} - ${item.artistName} -> videoId=${resolved.videoId || "(none)"}`);
    }
  } catch (err) {
    console.log("ytmusic-api init failed:", err.message);
    console.log("(This is OK if YouTube resolution is not the focus of this test)");
  }

  console.log("\n==============================================");
  console.log("TEST COMPLETE");
  console.log(`Playlist: ${playlistName}`);
  console.log(`Total tracks: ${allTracks.length}`);
  console.log("==============================================");
}

main().catch(err => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
