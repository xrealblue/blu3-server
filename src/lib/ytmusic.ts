import YTMusic from "ytmusic-api";

let ytmusic: YTMusic | null = null;

export async function getYTMusic(): Promise<YTMusic> {
  if (ytmusic) return ytmusic;
  ytmusic = new YTMusic();
  await ytmusic.initialize();
  return ytmusic;
}

export function resetYTMusic() {
  ytmusic = null;
}
