import * as dotenv from "dotenv";
import { existsSync } from "fs";
dotenv.config();
if (existsSync(".env.private")) dotenv.config({ path: ".env.private" });

import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);

const statements = [
  `ALTER TABLE "user" ALTER COLUMN "created_at" SET DEFAULT now();`,
  `ALTER TABLE "user" ALTER COLUMN "updated_at" SET DEFAULT now();`,
  `ALTER TABLE "session" ALTER COLUMN "created_at" SET DEFAULT now();`,
  `ALTER TABLE "session" ALTER COLUMN "updated_at" SET DEFAULT now();`,
  `ALTER TABLE "account" ALTER COLUMN "created_at" SET DEFAULT now();`,
  `ALTER TABLE "account" ALTER COLUMN "updated_at" SET DEFAULT now();`,
];

async function main() {
  for (const stmt of statements) {
    console.log("Running:", stmt);
    try {
      await sql(stmt);
      console.log("  OK");
    } catch (e: any) {
      console.error("  Error:", e.message || e);
    }
  }
  console.log("Done.");
}

main().catch(console.error);
