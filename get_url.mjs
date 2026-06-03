import { Innertube, FormatUtils, Platform } from "youtubei.js";

Platform.load({
  ...Platform.shim,
  eval: (data, env) => {
    const keys = Object.keys(env);
    const values = keys.map((k) => env[k]);
    return new Function(...keys, data.output)(...values);
  },
});

const yt = await Innertube.create({ cookie: process.env.YT_COOKIES || "" });
const info = await yt.getBasicInfo("VakIL7o6Vz0");

// Get the first format with a URL
for (const f of info.streaming_data.formats) {
  if (f.url) {
    console.log(f.url);
    process.exit(0);
  }
}
console.error("No URL found");
process.exit(1);
