import { Hono } from "hono";
import { users } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { sign, verify } from "hono/jwt";
import { db } from "../db/index.js";

const auth = new Hono();

auth.get("/google", (c) => {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: `${process.env.BACKEND_URL}/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
  });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

auth.get("/google/callback", async (c) => {
  try {
    const code = c.req.query("code");
    if (!code) return c.json({ error: "No code provided" }, 400);

    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: `${process.env.BACKEND_URL}/auth/google/callback`,
        grant_type: "authorization_code",
      }),
    });

    const tokens = await tokenRes.json();
    if (!tokens.access_token) {
      console.error("Token exchange failed:", tokens);
      return c.json({ error: "Token exchange failed", details: tokens }, 400);
    }

    const profileRes = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      },
    );
    const profile = await profileRes.json();
    console.log("PROFILE:", profile);

    if (!profile.id) {
      return c.json({ error: "Failed to get profile from Google" }, 400);
    }

    const existing = await db
      .select()
      .from(users)
      .where(eq(users.googleId, profile.id))
      .limit(1);

    let user;
    if (existing.length > 0) {
      const [updated] = await db
        .update(users)
        .set({
          email: profile.email,
          name: profile.name,
          avatar: profile.picture,
        })
        .where(eq(users.googleId, profile.id))
        .returning();
      user = updated;
      console.log("USER UPDATED:", user.email);
    } else {
      const [newUser] = await db
        .insert(users)
        .values({
          googleId: profile.id,
          email: profile.email,
          name: profile.name,
          avatar: profile.picture,
        })
        .returning();
      user = newUser;
      console.log("USER CREATED:", user.email);
    }

    const token = await sign(
      {
        sub: user.id,
        email: user.email,
        name: user.name,
        avatar: user.avatar,
        exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
      },
      process.env.JWT_SECRET!,
      "HS256",
    );

    const rawFrontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";
    const cleanFrontendUrl = rawFrontendUrl.replace(/^"|"$/g, "");
    const frontendUrls = cleanFrontendUrl
      .split(",")
      .map((url) => url.trim().replace(/\/$/, ""))
      .filter(Boolean);

    let targetFrontend = frontendUrls[0] || "http://localhost:3000";
    const referer = c.req.header("Referer") || c.req.header("Origin") || "";
    if (referer) {
      const matched = frontendUrls.find((url) => referer.startsWith(url));
      if (matched) {
        targetFrontend = matched;
      }
    }

    return c.redirect(
      `${targetFrontend}/auth/callback?token=${token}`,
    );
  } catch (err) {
    console.error("Auth callback error:", err);
    return c.json({ error: "Internal Error", details: String(err) }, 500);
  }
});

auth.get("/me", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer "))
    return c.json({ error: "Unauthorized" }, 401);

  try {
    const payload = await verify(
      authHeader.slice(7),
      process.env.JWT_SECRET!,
      "HS256",
    );
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, payload.sub as string))
      .limit(1);
    if (!user) return c.json({ error: "User not found" }, 401);
    return c.json({ user: payload });
  } catch (err) {
    console.error("JWT verify error:", err);
    return c.json({ error: "Invalid token" }, 401);
  }
});

export default auth;
