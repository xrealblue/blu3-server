async function testSpotifyDown() {
  const playlistId = "37i9dQZF1DWZmwe0RTeFj4";
  const url = `https://api.spotifydown.com/trackList/playlist/${playlistId}`;
  console.log("FETCHING FROM SPOTIFYDOWN TRACKLIST:", url);
  try {
    const res = await fetch(url, {
      headers: {
        "Origin": "https://spotifydown.com",
        "Referer": "https://spotifydown.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });

    console.log("Status:", res.status);
    const data = await res.json();
    console.log("Response keys:", Object.keys(data));
    if (data.success) {
      console.log("Track list items count:", data.trackList?.length);
      console.log("First track:", data.trackList?.[0]);
    } else {
      console.log("Failed:", data);
    }
  } catch (err) {
    console.error("Fetch failed:", err);
  }
}

testSpotifyDown();
