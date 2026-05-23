import { pgTable, text, timestamp, integer, uuid } from "drizzle-orm/pg-core";

export const rooms = pgTable("rooms", {
  id: text("id").primaryKey(),
  hostId: text("host_id").notNull(),
  currentVideoId: text("current_video_id"),
  currentTrackName: text("current_track_name"),
  currentTrackArtist: text("current_track_artist"),
  currentTrackImage: text("current_track_image"),
  playerState: text("player_state").default("paused"),
  seekPosition: integer("seek_position").default(0),
  updatedAt: timestamp("updated_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
});

export const messages = pgTable("messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  roomId: text("room_id")
    .notNull()
    .references(() => rooms.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  username: text("username").notNull(),
  text: text("text").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});
