import { Innertube, FormatUtils, Platform } from "youtubei.js";

Platform.load({
  ...Platform.shim,
  eval: (data, env) => {
    const keys = Object.keys(env);
    const values = keys.map((k) => env[k]);
    return new Function(...keys, data.output)(...values);
  },
});

const cookie = process.env.YT_COOKIES || "";
const yt = await Innertube.create({ cookie });
const info = await yt.getBasicInfo("VakIL7o6Vz0");

const formats = [
  ...(info.streaming_data.formats || []),
  ...(info.streaming_data.adaptive_formats || []),
];

// Test all formats to see which have valid decipher results
for (let i = 0; i < Math.min(formats.length, 5); i++) {
  const f = formats[i];
  console.log(`[${i}] itag=${f.itag} has_audio=${f.has_audio} has_video=${f.has_video}`);
  console.log(`    has_url=${!!f.url} has_cipher=${!!f.cipher} has_sig=${!!f.signature_cipher}`);
  try {
    const url = f.url || (await f.decipher(yt.session.player));
    if (url) {
      console.log(`    URL[:150]: ${url.substring(0, 150)}`);
      // Try fetch
      const resp = await fetch(url, { method: "HEAD", redirect: "follow" });
      console.log(`    HEAD status: ${resp.status}, ok: ${resp.ok}`);
    } else {
      console.log(`    No URL from decipher`);
    }
  } catch (e) {
    console.log(`    Error: ${e.message}`);
  }
}
