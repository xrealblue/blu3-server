import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import YTMusic from "ytmusic-api";

let ytmusic: YTMusic | null = null;

async function getYTMusic(): Promise<YTMusic> {
  if (ytmusic) return ytmusic;
  ytmusic = new YTMusic();
  await ytmusic.initialize();
  console.log("blu3 in");
  return ytmusic;
}

getYTMusic().catch(console.error);

const app = new Hono();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: ["http://localhost:3000"],
    allowMethods: ["GET"],
  }),
);

app.get("/", (c) => c.json({ status: "ok", service: "ytaudio-api" }));
