const { neon } = require('@neondatabase/serverless');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
dotenv.config();

const sql = neon(process.env.DATABASE_URL);

async function main() {
  const migrationPath = path.join(__dirname, '..', 'drizzle', '0005_migrate_uuid_to_text.sql');
  const content = fs.readFileSync(migrationPath, 'utf8');

  const statements = content.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean);

  console.log('Executing ' + statements.length + ' statements...');
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    console.log('\n--- Statement ' + (i + 1) + ' ---');
    console.log(stmt.slice(0, 120) + (stmt.length > 120 ? '...' : ''));
    try {
      const result = await sql.query(stmt);
      console.log('OK (' + (result?.rowCount ?? 0) + ' rows)');
    } catch (e) {
      console.error('ERROR:', e.message);
      console.error('SQL:', stmt.slice(0, 200));
    }
  }

  console.log('\nDone!');
}
main().catch(console.error).then(() => process.exit(0));
