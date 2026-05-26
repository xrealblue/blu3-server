import YTMusic from "ytmusic-api";

async function test() {
  try {
    const ytmusic = new YTMusic();
    await ytmusic.initialize();

    const rawId = "PL3oW2tJiIXbQA85V5wDPr0-4aDq3R1a8X";
    console.log("TESTING RAW ID:", rawId);
    try {
      const meta = await ytmusic.getPlaylist(rawId);
      console.log("getPlaylist (RAW ID) SUCCESS:", meta.name);
    } catch (e) {
      console.log("getPlaylist (RAW ID) FAILED:", e.message);
    }

    try {
      const videos = await ytmusic.getPlaylistVideos(rawId);
      console.log("getPlaylistVideos (RAW ID) SUCCESS:", videos.length, "videos");
    } catch (e) {
      console.log("getPlaylistVideos (RAW ID) FAILED:", e.message);
    }

    const vlId = "VL" + rawId;
    console.log("\nTESTING VL ID:", vlId);
    try {
      const meta = await ytmusic.getPlaylist(vlId);
      console.log("getPlaylist (VL ID) SUCCESS:", meta.name);
    } catch (e) {
      console.log("getPlaylist (VL ID) FAILED:", e.message);
    }

    try {
      const videos = await ytmusic.getPlaylistVideos(vlId);
      console.log("getPlaylistVideos (VL ID) SUCCESS:", videos.length, "videos");
    } catch (e) {
      console.log("getPlaylistVideos (VL ID) FAILED:", e.message);
    }

  } catch (err) {
    console.error("Initialization failed:", err);
  }
}

test();
