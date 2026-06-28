import "../src/lib/env.js";
import postgres from "postgres";

async function main() {
  const sql = postgres(process.env.DATABASE_URL!);

  console.log("Clearing all data except user accounts...");

  await sql`DELETE FROM playlist_tracks`;
  await sql`DELETE FROM playlists`;
  await sql`DELETE FROM room_queue`;
  await sql`DELETE FROM room_track_history`;
  await sql`DELETE FROM room_members`;
  await sql`DELETE FROM rooms`;

  console.log("Done. User accounts, sessions, and auth data preserved.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
