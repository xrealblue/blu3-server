const { neon } = require('@neondatabase/serverless');
const dotenv = require('dotenv');
dotenv.config();
const sql = neon(process.env.DATABASE_URL);
async function main() {
  const result = await sql('SELECT 1 as test');
  console.log('Raw query works:', JSON.stringify(result));
}
main().catch(console.error).then(() => process.exit(0));
