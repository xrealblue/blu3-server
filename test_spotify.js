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

    // Fetch public playlist ITEMS (Focus Flow)
    const playlistId = "37i9dQZF1DWZmwe0RTeFj4";
    const itemsUrl = `https://api.spotify.com/v1/playlists/${playlistId}/items`;
    console.log(`Fetching items from ${itemsUrl}...`);
    
    const res = await fetch(itemsUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    console.log("Items response status:", res.status);
    const data = await res.json();
    if (res.ok) {
      console.log("Success! Items count:", data.items?.length);
      console.log("First track:", data.items?.[0]?.track?.name);
      console.log("First artist:", data.items?.[0]?.track?.artists?.[0]?.name);
    } else {
      console.log("Error details:", data);
    }
  } catch (err) {
    console.error("Test failed:", err);
  }
}

testSpotify();
