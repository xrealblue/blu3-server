import { Hono, type MiddlewareHandler } from "hono";
import { db } from "../db/index.js";
import { rooms, roomMembers, users } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import { verify } from "hono/jwt";

type RoomsEnv = {
  Variables: {
    userId: string;
  };
};

const roomsRoute = new Hono<RoomsEnv>();

const requireAuth: MiddlewareHandler<RoomsEnv> = async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer "))
    return c.json({ error: "Unauthorized" }, 401);
  try {
    const payload = await verify(
      header.slice(7),
      process.env.JWT_SECRET!,
      "HS256",
    ); // ← "HS256"
    c.set("userId", payload.sub as string);
    await next();
  } catch (err) {
    console.error("Room auth error:", err);
    return c.json({ error: "Invalid token" }, 401);
  }
};

// Generate random room code
function genCode(len = 6) {
  return Math.random()
    .toString(36)
    .substring(2, 2 + len)
    .toUpperCase();
}

roomsRoute.post("/", requireAuth, async (c) => {
  const userId = c.get("userId");
  const { name } = await c.req.json();
  if (!name?.trim()) return c.json({ error: "Room name required" }, 400);

  let code = genCode();
  while (
    (await db.select().from(rooms).where(eq(rooms.code, code))).length > 0
  ) {
    code = genCode();
  }

  const [room] = await db
    .insert(rooms)
    .values({ code, name: name.trim(), hostId: userId })
    .returning();

  await db.insert(roomMembers).values({ roomId: room.id, userId });

  return c.json({ room });
});

roomsRoute.get("/:code", requireAuth, async (c) => {
  const code = c.req.param("code").toUpperCase();

  const [room] = await db
    .select()
    .from(rooms)
    .where(eq(rooms.code, code))
    .limit(1);
  if (!room) return c.json({ error: "Room not found" }, 404);
  if (!room.isActive) return c.json({ error: "Room is closed" }, 410);

  const members = await db
    .select({ id: users.id, name: users.name, avatar: users.avatar })
    .from(roomMembers)
    .innerJoin(users, eq(roomMembers.userId, users.id))
    .where(eq(roomMembers.roomId, room.id));

  return c.json({ room, members });
});

roomsRoute.post("/:code/join", requireAuth, async (c) => {
  const userId = c.get("userId");
  const code = c.req.param("code").toUpperCase();

  const [room] = await db
    .select()
    .from(rooms)
    .where(eq(rooms.code, code))
    .limit(1);
  if (!room) return c.json({ error: "Room not found" }, 404);
  if (!room.isActive) return c.json({ error: "Room is closed" }, 410);

  const existing = await db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, userId)))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(roomMembers).values({ roomId: room.id, userId });
  }

  return c.json({ room, joined: true });
});

// DELETE /api/rooms/:code — close room (host only)
roomsRoute.delete("/:code", requireAuth, async (c) => {
  const userId = c.get("userId");
  const code = c.req.param("code").toUpperCase();

  const [room] = await db
    .select()
    .from(rooms)
    .where(eq(rooms.code, code))
    .limit(1);
  if (!room) return c.json({ error: "Room not found" }, 404);
  if (room.hostId !== userId)
    return c.json({ error: "Only host can close room" }, 403);

  await db.update(rooms).set({ isActive: false }).where(eq(rooms.id, room.id));
  return c.json({ success: true });
});

// GET /api/rooms/user/mine — all rooms for current user
roomsRoute.get("/user/mine", async (c) => {
  const userId = c.get("userId");

  const myRooms = await db
    .select({
      id: rooms.id,
      code: rooms.code,
      name: rooms.name,
      hostId: rooms.hostId,
      isActive: rooms.isActive,
      createdAt: rooms.createdAt,
    })
    .from(roomMembers)
    .innerJoin(rooms, eq(roomMembers.roomId, rooms.id))
    .where(eq(roomMembers.userId, userId))
    .orderBy(rooms.createdAt);

  return c.json({ rooms: myRooms });
});

export default roomsRoute;
