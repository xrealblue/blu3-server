import { db } from "./db/index.js";
import { errorsTotal } from "./lib/metrics.js";

let started = false;

export function startCronJobs() {
  if (started) return;
  started = true;

  setInterval(async () => {
    try {
      const result = await db.execute(
        `DELETE FROM room_queue WHERE room_id NOT IN (SELECT id FROM rooms)`
      );
      if (result.rowCount && result.rowCount > 0) {
        console.log(`[Cron] cleaned ${result.rowCount} orphaned queue entries`);
      }
    } catch (err) {
      console.error("[Cron] orphaned queue cleanup error:", err);
      errorsTotal.inc({ source: "cron" });
    }
  }, 60 * 60 * 1000);

  setInterval(async () => {
    try {
      const result = await db.execute(
        `DELETE FROM room_members WHERE room_id NOT IN (SELECT id FROM rooms)`
      );
      if (result.rowCount && result.rowCount > 0) {
        console.log(`[Cron] cleaned ${result.rowCount} orphaned room members`);
      }
    } catch (err) {
      console.error("[Cron] orphaned members cleanup error:", err);
      errorsTotal.inc({ source: "cron" });
    }
  }, 60 * 60 * 1000);

  setInterval(async () => {
    try {
      await db.execute(`
        DELETE FROM room_track_history
        WHERE id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY room_id ORDER BY played_at DESC) AS rn
            FROM room_track_history
          ) sub WHERE sub.rn > 50
        )
      `);
      console.log(`[Cron] pruned room track history`);
    } catch (err) {
      console.error("[Cron] track history pruning error:", err);
      errorsTotal.inc({ source: "cron" });
    }
  }, 6 * 60 * 60 * 1000);

  console.log("[Cron] cleanup jobs started");
}
