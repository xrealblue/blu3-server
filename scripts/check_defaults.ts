import * as dotenv from "dotenv";
import { existsSync } from "fs";
dotenv.config();
if (existsSync(".env.private")) dotenv.config({ path: ".env.private" });

import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

async function main() {
  const result = await sql`
    SELECT
      table_name,
      column_name,
      column_default
    FROM information_schema.columns
    WHERE table_name IN ('user', 'session', 'account')
      AND column_name IN ('created_at', 'updated_at')
    ORDER BY table_name, column_name;
  `;
  console.log(JSON.stringify(result, null, 2));

  // Try applying via tagged template
  console.log("\nApplying via tagged template...");
  
  const statements = [
    `ALTER TABLE "user" ALTER COLUMN "created_at" SET DEFAULT now();`,
    `ALTER TABLE "user" ALTER COLUMN "updated_at" SET DEFAULT now();`,
    `ALTER TABLE "session" ALTER COLUMN "created_at" SET DEFAULT now();`,
    `ALTER TABLE "session" ALTER COLUMN "updated_at" SET DEFAULT now();`,
    `ALTER TABLE "account" ALTER COLUMN "created_at" SET DEFAULT now();`,
    `ALTER TABLE "account" ALTER COLUMN "updated_at" SET DEFAULT now();`,
  ];

  for (const stmt of statements) {
    console.log("Running:", stmt);
    try {
      await sql(stmt);  // This will fail - neon requires tagged template
      console.log("  OK");
    } catch (e: any) {
      console.log("  Failed (expected):", e.message?.substring(0, 80));
    }
  }

  // Use sql.query instead
  console.log("\nTrying sql.query...");
  for (const stmt of statements) {
    console.log("Running:", stmt);
    try {
      await (sql as any).query(stmt);
      console.log("  OK");
    } catch (e: any) {
      console.log("  Failed:", e.message?.substring(0, 80));
    }
  }

  // Verify after
  const result2 = await sql`
    SELECT
      table_name,
      column_name,
      column_default
    FROM information_schema.columns
    WHERE table_name IN ('user', 'session', 'account')
      AND column_name IN ('created_at', 'updated_at')
    ORDER BY table_name, column_name;
  `;
  console.log("\nAfter:");
  console.log(JSON.stringify(result2, null, 2));
}

main().catch(console.error);
