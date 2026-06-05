-- Phase 1: Migrate old-only users into the new user table
-- Map: old avatar -> new image, old created_at -> new created_at, set updated_at = NOW()
INSERT INTO "user" (id, email, email_verified, name, image, created_at, updated_at)
SELECT
  o.id::text,
  COALESCE(o.email, 'unknown-' || o.id::text || '@migrated.local'),
  false,
  COALESCE(o.name, 'Unknown'),
  o.avatar,
  o.created_at,
  NOW()
FROM "users" o
WHERE NOT EXISTS (SELECT 1 FROM "user" n WHERE n.email = o.email);
--> statement-breakpoint
-- Phase 2: Drop all FK constraints on uuid columns (both external to old users table and internal)
ALTER TABLE "rooms" DROP CONSTRAINT IF EXISTS "rooms_host_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "room_members" DROP CONSTRAINT IF EXISTS "room_members_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "playlists" DROP CONSTRAINT IF EXISTS "playlists_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "room_members" DROP CONSTRAINT IF EXISTS "room_members_room_id_rooms_id_fk";
--> statement-breakpoint
ALTER TABLE "room_queue" DROP CONSTRAINT IF EXISTS "room_queue_room_id_rooms_id_fk";
--> statement-breakpoint
ALTER TABLE "room_track_history" DROP CONSTRAINT IF EXISTS "room_track_history_room_id_rooms_id_fk";
--> statement-breakpoint
ALTER TABLE "playlist_tracks" DROP CONSTRAINT IF EXISTS "playlist_tracks_playlist_id_playlists_id_fk";
--> statement-breakpoint
-- Phase 3: Alter all uuid columns to text
ALTER TABLE "rooms" ALTER COLUMN "id" TYPE text USING "id"::text;
--> statement-breakpoint
ALTER TABLE "rooms" ALTER COLUMN "host_id" TYPE text USING "host_id"::text;
--> statement-breakpoint
ALTER TABLE "room_members" ALTER COLUMN "id" TYPE text USING "id"::text;
--> statement-breakpoint
ALTER TABLE "room_members" ALTER COLUMN "room_id" TYPE text USING "room_id"::text;
--> statement-breakpoint
ALTER TABLE "room_members" ALTER COLUMN "user_id" TYPE text USING "user_id"::text;
--> statement-breakpoint
ALTER TABLE "room_queue" ALTER COLUMN "id" TYPE text USING "id"::text;
--> statement-breakpoint
ALTER TABLE "room_queue" ALTER COLUMN "room_id" TYPE text USING "room_id"::text;
--> statement-breakpoint
ALTER TABLE "room_track_history" ALTER COLUMN "id" TYPE text USING "id"::text;
--> statement-breakpoint
ALTER TABLE "room_track_history" ALTER COLUMN "room_id" TYPE text USING "room_id"::text;
--> statement-breakpoint
ALTER TABLE "playlists" ALTER COLUMN "id" TYPE text USING "id"::text;
--> statement-breakpoint
ALTER TABLE "playlists" ALTER COLUMN "user_id" TYPE text USING "user_id"::text;
--> statement-breakpoint
ALTER TABLE "playlist_tracks" ALTER COLUMN "id" TYPE text USING "id"::text;
--> statement-breakpoint
ALTER TABLE "playlist_tracks" ALTER COLUMN "playlist_id" TYPE text USING "playlist_id"::text;
--> statement-breakpoint
-- Phase 4: Update FK references for the user who exists in both old and new tables
-- (gaheet007@gmail.com: old UUID -> new text ID)
UPDATE "rooms" SET "host_id" = n.id
FROM "user" n, "users" o
WHERE o.email = n.email AND "rooms"."host_id" = o.id::text;
--> statement-breakpoint
UPDATE "room_members" SET "user_id" = n.id
FROM "user" n, "users" o
WHERE o.email = n.email AND "room_members"."user_id" = o.id::text;
--> statement-breakpoint
UPDATE "playlists" SET "user_id" = n.id
FROM "user" n, "users" o
WHERE o.email = n.email AND "playlists"."user_id" = o.id::text;
--> statement-breakpoint
-- Phase 5: Re-add FK constraints (internal app tables + referencing new user table)
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_room_id_rooms_id_fk"
  FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "room_queue" ADD CONSTRAINT "room_queue_room_id_rooms_id_fk"
  FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "room_track_history" ADD CONSTRAINT "room_track_history_room_id_rooms_id_fk"
  FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "playlist_tracks" ADD CONSTRAINT "playlist_tracks_playlist_id_playlists_id_fk"
  FOREIGN KEY ("playlist_id") REFERENCES "public"."playlists"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_host_id_user_id_fk"
  FOREIGN KEY ("host_id") REFERENCES "public"."user"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "room_members" ADD CONSTRAINT "room_members_user_id_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "playlists" ADD CONSTRAINT "playlists_user_id_user_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade;
--> statement-breakpoint
-- Phase 6: Deprecate old users table
ALTER TABLE "users" RENAME TO "users_backup";
