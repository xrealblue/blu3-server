import {
  pgTable,
  text,
  timestamp,
  boolean,
  index,
  integer,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const users = pgTable("user", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  name: text("name").notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const sessions = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
});

export const accounts = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at"),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at").notNull(),
    updatedAt: timestamp("updated_at").notNull(),
  },
);

export const verifications = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
);

export const rooms = pgTable("rooms", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  hostId: text("host_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  hostName: text("host_name").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const roomMembers = pgTable("room_members", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  roomId: text("room_id")
    .notNull()
    .references(() => rooms.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  joinedAt: timestamp("joined_at").defaultNow().notNull(),
});

// db/schema.ts — add this table

export const roomTrackHistory = pgTable(
  "room_track_history",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()`),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    videoId: text("video_id").notNull(),
    trackName: text("track_name").notNull(),
    artistName: text("artist_name").notNull(),
    image: text("image").notNull().default(""),
    playedAt: timestamp("played_at").defaultNow().notNull(),
  },
  (t) => [
    index("rth_room_idx").on(t.roomId),
    index("rth_played_at_idx").on(t.playedAt),
  ],
);

export const roomQueue = pgTable(
  "room_queue",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()`),
    roomId: text("room_id")
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

export const playlists = pgTable("playlists", {
  id: text("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  isLiked: boolean("is_liked").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const playlistTracks = pgTable(
  "playlist_tracks",
  {
    id: text("id").primaryKey().default(sql`gen_random_uuid()`),
    playlistId: text("playlist_id")
      .notNull()
      .references(() => playlists.id, { onDelete: "cascade" }),
    videoId: text("video_id").notNull(),
    trackName: text("track_name").notNull(),
    artistName: text("artist_name").notNull(),
    image: text("image").notNull().default(""),
    durationMs: integer("duration_ms").notNull().default(0),
    position: integer("position").notNull().default(0),
    addedAt: timestamp("added_at").defaultNow().notNull(),
  },
  (t) => [
    index("pt_playlist_idx").on(t.playlistId),
    index("pt_position_idx").on(t.position),
  ],
);

export type Playlist = typeof playlists.$inferSelect;
export type PlaylistTrack = typeof playlistTracks.$inferSelect;
