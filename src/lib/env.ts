import * as dotenv from "dotenv";
import { existsSync } from "node:fs";

dotenv.config();
if (existsSync(".env.private")) dotenv.config({ path: ".env.private" });
