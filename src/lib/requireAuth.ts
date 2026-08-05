import { Hono, type MiddlewareHandler } from "hono";
import { getSessionFromRequest } from "./auth.js";

export type AuthEnv = {
  Variables: {
    userId: string;
  };
};

export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const session = await getSessionFromRequest(c.req.raw.headers);
  if (!session?.user) return c.json({ error: "Unauthorized" }, 401);
  c.set("userId", session.user.id);
  await next();
};

export function createAuthedRoute() {
  const route = new Hono<AuthEnv>();
  route.use("*", requireAuth);
  return route;
}
