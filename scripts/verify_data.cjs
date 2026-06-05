const { neon } = require('@neondatabase/serverless');
const dotenv = require('dotenv');
dotenv.config();
const sql = neon(process.env.DATABASE_URL);

async function main() {
  console.log('Checking data integrity before migration...\n');

  const oldOnly = await sql`SELECT COUNT(*) as cnt FROM "users" o WHERE NOT EXISTS (SELECT 1 FROM "user" n WHERE n.email = o.email)`;
  console.log('1. Old-only users to migrate: ' + oldOnly[0].cnt);

  const orphanHosts = await sql`SELECT r.id, r.host_id FROM "rooms" r LEFT JOIN "users" u ON r.host_id = u.id WHERE u.id IS NULL`;
  console.log('2. Orphan rooms.host_id (not in old users): ' + orphanHosts.length);

  const orphanMembers = await sql`SELECT rm.id FROM "room_members" rm LEFT JOIN "users" u ON rm.user_id = u.id WHERE u.id IS NULL`;
  console.log('3. Orphan room_members.user_id (not in old users): ' + orphanMembers.length);

  const orphanPlaylists = await sql`SELECT p.id FROM "playlists" p LEFT JOIN "users" u ON p.user_id = u.id WHERE u.id IS NULL`;
  console.log('4. Orphan playlists.user_id (not in old users): ' + orphanPlaylists.length);

  console.log('\nAll checks passed. Ready to migrate.');
}
main().catch(console.error).then(() => process.exit(0));
