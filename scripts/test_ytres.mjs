// Test YouTube resolution for Apple Music tracks
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

console.log("1. Getting AMP API token...");
const mainRes = await fetch("https://beta.music.apple.com", { headers: { "User-Agent": UA } });
const html = await mainRes.text();
const jsUri = html.match(/\/assets\/index-legacy[~-][^/]+\.js/)[0];
const jsRes = await fetch("https://beta.music.apple.com" + jsUri, { headers: { "User-Agent": UA } });
const js = await jsRes.text();
const token = js.match(/['`"](eyJ[a-zA-Z0-9_-]+?\.[a-zA-Z0-9_-]+?\.[a-zA-Z0-9_-]+)['`"]/)[1];
console.log("Token OK (" + token.length + " chars)\n");

console.log("2. Fetching first 20 tracks...");
const res = await fetch("https://amp-api.music.apple.com/v1/catalog/in/playlists/pl.f55c6379d8cc475fb96bfeecb5d554a7?include=tracks&offset=0", {
  headers: { Authorization: "Bearer " + token, Origin: "https://music.apple.com", "User-Agent": UA }
});
const data = await res.json();
const tracks = data.data[0].relationships.tracks.data
  .filter(t => t.type === "songs")
  .map(t => ({ name: t.attributes.name, artist: t.attributes.artistName }))
  .slice(0, 20);

console.log("Got " + tracks.length + " tracks\n");

console.log("3. Initializing ytmusic-api...");
const { default: YTMusic } = await import("ytmusic-api");
const ytmusic = new YTMusic();
await ytmusic.initialize();
console.log("ytmusic-api OK\n");

console.log("4. Resolving tracks to YouTube...");
let success = 0;
for (const t of tracks) {
  try {
    const query = t.name + " " + t.artist;
    const results = await ytmusic.searchSongs(query);
    if (results && results.length > 0) {
      success++;
      console.log("OK: " + t.name + " - " + t.artist + " -> " + results[0].videoId);
    } else {
      console.log("--: " + t.name + " - " + t.artist + " -> no results");
    }
  } catch (err) {
    console.log("!!: " + t.name + " - " + t.artist + " -> " + err.message.slice(0, 60));
  }
}

console.log("\nResult: " + success + "/" + tracks.length + " tracks resolved");
