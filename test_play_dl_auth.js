import play from "play-dl";
import * as dotenv from "dotenv";
dotenv.config();

async function testPlayDlWithCredentials() {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.log("Missing Spotify credentials!");
    return;
  }

  try {
    console.log("Setting Spotify token in play-dl...");
    // Let's set the token using client_id and client_secret
    await play.setToken({
      spotify: {
        client_id: clientId,
        client_secret: clientSecret
      }
    });

    console.log("Token set! Attempting to validate and fetch playlist...");
    const url = "https://open.spotify.com/playlist/37i9dQZF1DWZmwe0RTeFj4";
    const validation = play.sp_validate(url);
    console.log("Validation status:", validation);

    if (validation === "playlist") {
      const data = await play.spotify(url);
      console.log("SUCCESS! Playlist Title:", data.name);
      const tracks = await data.all_tracks();
      console.log("Tracks count:", tracks.length);
      console.log("First track:", tracks[0]?.name);
    } else {
      console.log("URL is not recognized as a Spotify playlist");
    }
  } catch (err) {
    console.error("play-dl with credentials failed:", err);
  }
}

testPlayDlWithCredentials();
