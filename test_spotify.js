import * as dotenv from "dotenv";
dotenv.config();

async function testSpotify() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  console.log("CLIENT ID:", clientId);
  console.log("CLIENT SECRET:", clientSecret);

  if (!clientId || !clientSecret) {
    console.log("Missing Spotify credentials!");
    return;
  }

  try {
    // 1. Get access token
    console.log("Exchanging token...");
    const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });

    const tokenData = await tokenRes.json();
    console.log("Token response:", tokenData);

    const accessToken = tokenData.access_token;
    if (!accessToken) {
      console.log("Failed to get access token!");
      return;
    }

    // 2. Fetch public playlist (e.g. Spotify's Today's Top Hits)
    const playlistId = "37i9dQZF1DXcBWIGsyNaS1";
    console.log(`Fetching playlist ${playlistId}...`);
    const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    console.log("Playlist status:", res.status);
    const data = await res.json();
    if (res.ok) {
      console.log("Playlist Name:", data.name);
      console.log("Track Count:", data.tracks?.items?.length);
      console.log("First track:", data.tracks?.items?.[0]?.track?.name);
    } else {
      console.log("Error details:", data);
    }
  } catch (err) {
    console.error("Test failed:", err);
  }
}

testSpotify();
