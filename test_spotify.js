import * as dotenv from "dotenv";
dotenv.config();

async function testSpotify() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.log("Missing Spotify credentials!");
    return;
  }

  try {
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
    const accessToken = tokenData.access_token;
    if (!accessToken) {
      console.log("Failed to get access token!");
      return;
    }

    // Try fetching /tracks
    const playlistId = "37i9dQZF1DWZmwe0RTeFj4";
    const tracksUrl = `https://api.spotify.com/v1/playlists/${playlistId}/tracks`;
    console.log(`Fetching from ${tracksUrl}...`);
    
    const res = await fetch(tracksUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    console.log("Response status:", res.status);
    const text = await res.text();
    console.log("Raw Response Text:", text);

  } catch (err) {
    console.error("Test failed:", err);
  }
}

testSpotify();
