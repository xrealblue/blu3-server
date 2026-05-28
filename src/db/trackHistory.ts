import { db } from "./index.js";
import { roomTrackHistory } from "./schema.js";
import { eq, asc, sql } from "drizzle-orm";

export async function pushTrackHistory(
  roomId: string,
  track: {
    videoId: string;
    trackName: string;
    artistName: string;
    image: string;
  },
) {
  await db.insert(roomTrackHistory).values({
    roomId,
    videoId: track.videoId,
    trackName: track.trackName,
    artistName: track.artistName,
    image: track.image,
  });

  await db.execute(sql`
    DELETE FROM room_track_history
    WHERE room_id = ${roomId}
      AND id NOT IN (
        SELECT id FROM room_track_history
        WHERE room_id = ${roomId}
        ORDER BY played_at DESC
        LIMIT 10
      )
  `);
}

export async function getTrackHistory(roomId: string) {
  return db
    .select()
    .from(roomTrackHistory)
    .where(eq(roomTrackHistory.roomId, roomId))
    .orderBy(asc(roomTrackHistory.playedAt));
}
