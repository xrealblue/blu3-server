CREATE TABLE "room_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"video_id" text NOT NULL,
	"track_name" text NOT NULL,
	"artist_name" text NOT NULL,
	"image" text DEFAULT '' NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "room_queue" ADD CONSTRAINT "room_queue_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rq_room_idx" ON "room_queue" USING btree ("room_id");--> statement-breakpoint
CREATE INDEX "rq_position_idx" ON "room_queue" USING btree ("position");