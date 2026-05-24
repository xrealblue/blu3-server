// db/trackHistory.ts  (new file)
import { db } from "./index.js";
import { roomTrackHistory } from "./schema.js";
import { eq, asc, lt } from "drizzle-orm";
export async function pushTrackHistory(roomId, track) {
    // 1. Insert the new track
    await db.insert(roomTrackHistory).values({
        roomId,
        videoId: track.videoId,
        trackName: track.trackName,
        artistName: track.artistName,
        image: track.image,
    });
    // 2. Count total rows for this room
    const all = await db
        .select({ id: roomTrackHistory.id, playedAt: roomTrackHistory.playedAt })
        .from(roomTrackHistory)
        .where(eq(roomTrackHistory.roomId, roomId))
        .orderBy(asc(roomTrackHistory.playedAt)); // oldest → newest
    // 3. If more than 10, delete the oldest (first in the sorted list)
    if (all.length > 10) {
        const toDelete = all.slice(0, all.length - 10); // everything before the 10 newest
        for (const row of toDelete) {
            await db
                .delete(roomTrackHistory)
                .where(eq(roomTrackHistory.id, row.id));
        }
    }
}
export async function getTrackHistory(roomId) {
    return db
        .select()
        .from(roomTrackHistory)
        .where(eq(roomTrackHistory.roomId, roomId))
        .orderBy(asc(roomTrackHistory.playedAt)); // oldest → newest, so UI can reverse
}
