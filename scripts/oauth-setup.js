const { Innertube } = require("youtubei.js");

(async () => {
  const yt = await Innertube.create({
    client_type: "ANDROID",
    generate_session_locally: true,
  });

  const code = await yt.session.oauth.getDeviceAndUserCode();
  console.log("\n=== YouTube OAuth Authorization ===");
  console.log("1. Visit this URL in your browser:");
  console.log("   " + code.verification_url);
  console.log("\n2. Sign in with your YouTube account");
  console.log("\n3. Enter this code:");
  console.log("   " + code.user_code);
  console.log("\nWaiting for authorization (polling)...\n");

  const tokens = await new Promise((resolve, reject) => {
    yt.session.on("auth", (data) => {
      console.log("\nAuthorization successful!\n");
      resolve(data.credentials);
    });
    yt.session.on("auth-error", (err) => {
      reject(err);
    });
    yt.session.oauth.pollForAccessToken(code);
  });

  console.log("=== OAuth Tokens Obtained ===\n");
  console.log("Add these to blu3-server/.env.private:\n");
  console.log(`YT_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}`);
  console.log(`YT_OAUTH_ACCESS_TOKEN=${tokens.access_token}`);
  console.log(`YT_OAUTH_EXPIRY_DATE=${tokens.expiry_date}`);
  if (tokens.client) {
    console.log(`YT_OAUTH_CLIENT_ID=${tokens.client.client_id}`);
    console.log(`YT_OAUTH_CLIENT_SECRET=${tokens.client.client_secret}`);
  }
  console.log("\nDone! Restart the server after adding these.");
})();
