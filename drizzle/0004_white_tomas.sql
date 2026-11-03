ALTER TABLE "game_profile" ADD COLUMN "rating" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "game_profile" ADD COLUMN "rated_games" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "game_profile" ADD COLUMN "rated_wins" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "game_profile" ADD COLUMN "rated_losses" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "game_result" ADD COLUMN "player_one_rating_before" integer;--> statement-breakpoint
ALTER TABLE "game_result" ADD COLUMN "player_one_rating_after" integer;--> statement-breakpoint
ALTER TABLE "game_result" ADD COLUMN "player_two_rating_before" integer;--> statement-breakpoint
ALTER TABLE "game_result" ADD COLUMN "player_two_rating_after" integer;--> statement-breakpoint
CREATE INDEX "game_profile_leaderboard_idx" ON "game_profile" USING btree ("rating" DESC NULLS LAST,"public_id") WHERE "game_profile"."rated_games" > 0;