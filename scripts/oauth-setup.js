const { Innertube } = require("youtubei.js");

(async () => {
  const yt = await Innertube.create({
    client_type: "ANDROID",
    generate_session_locally: true,
  });

  yt.session.on("auth-pending", (data) => {
    console.log("\n=== YouTube OAuth Authorization ===");
    console.log("1. Visit this URL in your browser:");
    console.log("   " + data.verification_url);
    console.log("\n2. Sign in with your YouTube account");
    console.log("\n3. Enter this code:");
    console.log("   " + data.user_code);
    console.log("\nWaiting for authorization...\n");
  });

  yt.session.on("auth", (data) => {
    console.log("\n=== Authorization successful! ===\n");
    const t = data.credentials;
    console.log("Add these to blu3-server/.env.private:\n");
    console.log("YT_OAUTH_REFRESH_TOKEN=" + t.refresh_token);
    console.log("YT_OAUTH_ACCESS_TOKEN=" + t.access_token);
    console.log("YT_OAUTH_EXPIRY_DATE=" + t.expiry_date);
    if (t.client) {
      console.log("YT_OAUTH_CLIENT_ID=" + t.client.client_id);
      console.log("YT_OAUTH_CLIENT_SECRET=" + t.client.client_secret);
    }
    console.log("\nThen restart the server.");
    process.exit(0);
  });

  yt.session.on("auth-error", (err) => {
    console.error("\nAuthorization failed:", err.message);
    process.exit(1);
  });

  await yt.session.signIn();
})();
