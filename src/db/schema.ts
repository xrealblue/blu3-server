import {
  pgTable,
  text,
  timestamp,
  uuid,
  boolean,
  index,
  integer,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  googleId: text("google_id").notNull().unique(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  avatar: text("avatar"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const rooms = pgTable("rooms", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(), // short shareable code e.g. "ABC123"
  name: text("name").notNull(),
  hostId: uuid("host_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const roomMembers = pgTable("room_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  roomId: uuid("room_id")
    .notNull()
    .references(() => rooms.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  joinedAt: timestamp("joined_at").defaultNow().notNull(),
});

// db/schema.ts — add this table

export const roomTrackHistory = pgTable(
  "room_track_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    videoId: text("video_id").notNull(),
    trackName: text("track_name").notNull(),
    artistName: text("artist_name").notNull(),
    image: text("image").notNull().default(""),
    playedAt: timestamp("played_at").defaultNow().notNull(),
  },
  (t) => [
    index("rth_room_idx").on(t.roomId), // fast lookup per room
    index("rth_played_at_idx").on(t.playedAt), // fast ORDER BY playedAt DESC
  ],
);

export const roomQueue = pgTable(
  "room_queue",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    videoId: text("video_id").notNull(),
    trackName: text("track_name").notNull(),
    artistName: text("artist_name").notNull(),
    image: text("image").notNull().default(""),
    durationMs: integer("duration_ms").notNull().default(0),
    position: integer("position").notNull().default(0),
    addedAt: timestamp("added_at").defaultNow().notNull(),
  },
  (t) => [
    index("rq_room_idx").on(t.roomId),
    index("rq_position_idx").on(t.position),
  ],
);

export type RoomTrackHistory = typeof roomTrackHistory.$inferSelect;
export type User = typeof users.$inferSelect;
export type Room = typeof rooms.$inferSelect;
export type RoomMember = typeof roomMembers.$inferSelect;
export type RoomQueue = typeof roomQueue.$inferSelect;
