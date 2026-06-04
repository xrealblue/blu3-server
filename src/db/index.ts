import * as dotenv from "dotenv";
import { existsSync } from "fs";
dotenv.config();
if (existsSync(".env.private")) dotenv.config({ path: ".env.private" });

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema.js";

const sql = neon(process.env.DATABASE_URL!);
export const db = drizzle(sql, { schema });
