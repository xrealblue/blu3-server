async function testEmbed() {
  const playlistId = "37i9dQZF1DWZmwe0RTeFj4";
  const url = `https://open.spotify.com/embed/playlist/${playlistId}`;
  console.log("FETCHING SPOTIFY EMBED PAGE:", url);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    const html = await res.text();
    
    // Match __NEXT_DATA__ block
    const nextDataMatch = html.match(/<script.*?id="__NEXT_DATA__".*?>(.*?)<\/script>/s);
                         
    if (nextDataMatch) {
      console.log("Found __NEXT_DATA__!");
      const rawJson = nextDataMatch[1];
      const parsed = JSON.parse(rawJson);
      
      const props = parsed.props || {};
      const pageProps = props.pageProps || {};
      console.log("PageProps keys:", Object.keys(pageProps));
      
      // Let's dump all pageProps to see where tracks/name are
      console.log("Dump pageProps status:", pageProps.status);
      console.log("Dump pageProps title:", pageProps.title);
      
      // Let's dump some keys or the structure of props to locate tracks
      // Let's print the entire object if it's small, or check if it has a playlist property
      console.log("Dump pageProps state keys:", pageProps.state ? Object.keys(pageProps.state) : "No state");
      
      // If we find pageProps.state, let's explore it
      if (pageProps.state) {
        console.log("Dump state content:", JSON.stringify(pageProps.state, null, 2).slice(0, 1500));
      }
    } else {
      console.log("No __NEXT_DATA__ found!");
    }
  } catch (err) {
    console.error("Fetch failed:", err);
  }
}

testEmbed();
