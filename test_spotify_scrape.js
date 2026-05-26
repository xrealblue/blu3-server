async function testScrape() {
  const url = "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGsyNaS1";
  console.log("FETCHING SPOTIFY PAGE:", url);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    const html = await res.text();
    console.log("HTML length:", html.length);
    
    // Check if the HTML contains "initial-state" or "session" scripts
    const hasInitialState = html.includes("initial-state") || html.includes("initialState") || html.includes("EmbedData");
    console.log("Has initial state scripts:", hasInitialState);

    // Let's search for some tracks in the HTML text to see if they are in plain text!
    // We can search for titles or meta tags
    const titleMatch = html.match(/<title>(.*?)<\/title>/);
    console.log("Page Title:", titleMatch ? titleMatch[1] : "None");

    // Let's write the first 2000 chars of the HTML or save it to a file
    const fs = await import("fs");
    fs.writeFileSync("spotify_page.html", html);
    console.log("Saved page to spotify_page.html");

  } catch (err) {
    console.error("Fetch failed:", err);
  }
}

testScrape();
