CREATE TABLE "room_track_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"video_id" text NOT NULL,
	"track_name" text NOT NULL,
	"artist_name" text NOT NULL,
	"image" text DEFAULT '' NOT NULL,
	"played_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "room_track_history" ADD CONSTRAINT "room_track_history_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rth_room_idx" ON "room_track_history" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "rth_played_at_idx" ON "room_track_history" USING btree ("played_at");