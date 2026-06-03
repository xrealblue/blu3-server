import { Innertube } from "youtubei.js";

const yt = await Innertube.create({
  cookie: "APISID=ZmNEf2SsDvRTwqM3/AVFhf67_9JmBsb73p; SAPISID=GKc_-nxgkQWFDNwz/Aeq9NfF-ayceNeQwl",
});

const info = await yt.getBasicInfo("dQw4w9WgXcQ");
const sd = info.streaming_data;

if (sd?.adaptive_formats) {
  const af = sd.adaptive_formats[0];
  for (const k of Object.keys(af)) {
    const v = (af as any)[k];
    if (typeof v === "string" || typeof v === "number" || v === null || v === undefined) {
      console.log(k, ":", String(v ?? "null").slice(0, 100));
    }
  }
}
