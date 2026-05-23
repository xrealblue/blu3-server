// db/trackHistory.ts  (new file)

import { db } from "./index.js";
import { roomTrackHistory } from "./schema.js";
import { eq, asc, lt } from "drizzle-orm";

export async function pushTrackHistory(
  roomId: string,
  track: {
    videoId: string;
    trackName: string;
    artistName: string;
    image: string;
  },
) {
  await db.transaction(async (tx) => {
    // 1. Insert the new track
    await tx.insert(roomTrackHistory).values({
      roomId,
      videoId: track.videoId,
      trackName: track.trackName,
      artistName: track.artistName,
      image: track.image,
    });

    // 2. Find the cutoff — the playedAt of the 10th most recent row
    const rows = await tx
      .select({ playedAt: roomTrackHistory.playedAt })
      .from(roomTrackHistory)
      .where(eq(roomTrackHistory.roomId, roomId))
      .orderBy(asc(roomTrackHistory.playedAt)) // oldest first
      .limit(1); // will re-query after knowing count
    // We actually need count-based eviction — see note below
    // Count total rows for this room
    const all = await tx
      .select({ id: roomTrackHistory.id, playedAt: roomTrackHistory.playedAt })
      .from(roomTrackHistory)
      .where(eq(roomTrackHistory.roomId, roomId))
      .orderBy(asc(roomTrackHistory.playedAt)); // oldest → newest

    // 3. If more than 10, delete the oldest (first in the sorted list)
    if (all.length > 10) {
      const toDelete = all.slice(0, all.length - 10); // everything before the 10 newest
      for (const row of toDelete) {
        await tx
          .delete(roomTrackHistory)
          .where(eq(roomTrackHistory.id, row.id));
      }
    }
  });
}

export async function getTrackHistory(roomId: string) {
  return db
    .select()
    .from(roomTrackHistory)
    .where(eq(roomTrackHistory.roomId, roomId))
    .orderBy(asc(roomTrackHistory.playedAt)); // oldest → newest, so UI can reverse
}
