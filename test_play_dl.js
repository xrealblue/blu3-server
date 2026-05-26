import play from "play-dl";

async function testPlayDl() {
  const url = "https://open.spotify.com/playlist/37i9dQZF1DWZmwe0RTeFj4";
  console.log("TESTING PLAY-DL WITH SPOTIFY URL:", url);

  try {
    const isSpotify = play.sp_validate(url);
    console.log("Validation status:", isSpotify);

    if (isSpotify === "playlist") {
      const data = await play.spotify(url);
      console.log("Playlist Title:", data.name);
      
      const tracks = await data.all_tracks();
      console.log("Tracks count:", tracks.length);
      console.log("First track title:", tracks[0]?.name);
      console.log("First track artist:", tracks[0]?.artists?.map(a => a.name).join(", "));
      console.log("First track duration (ms):", tracks[0]?.durationInMs);
      console.log("First track thumbnail/image:", tracks[0]?.thumbnail?.url);
    } else {
      console.log("URL is not recognized as a Spotify playlist by play-dl");
    }
  } catch (err) {
    console.error("play-dl test failed:", err);
  }
}

testPlayDl();
