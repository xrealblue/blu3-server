import { betterAuth } from "better-auth";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { dash } from "@better-auth/infra";
import { db } from "../db/index.js";
import * as schema from "../db/schema.js";
import { eq } from "drizzle-orm";

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL!,
  secret: process.env.BETTER_AUTH_SECRET!,
  trustedOrigins: [
    "https://blu3.in",
    "https://api.blu3.in",
    "http://localhost:3000",
    "http://localhost:8000",
    ...(process.env.FRONTEND_URL?.split(",").map((s) => s.trim()).filter(Boolean) ?? [])
  ],
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.users,
      session: schema.sessions,
      account: schema.accounts,
      verification: schema.verifications,
    },
  }),
  plugins: [dash()],
  account: {
    storeStateStrategy: "cookie",
    accountLinking: {
      trustedProviders: ["google", "discord"],
      requireLocalEmailVerified: false,
    },
  },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
    discord: {
      clientId: process.env.DISCORD_CLIENT_ID!,
      clientSecret: process.env.DISCORD_SECRET!,
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
});

export async function getSessionFromRequest(headers: Headers) {
  const session = await auth.api.getSession({ headers });
  if (session) return session;

  const authHeader = headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const [s] = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.token, token))
      .limit(1);
    if (s && s.expiresAt > new Date()) {
      const [user] = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.id, s.userId))
        .limit(1);
      if (user) return { user, session: s };
    }
  }

  return null;
}
