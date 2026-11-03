CREATE TABLE "achievement_summary" (
	"user_id" text NOT NULL,
	"match_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"won" boolean NOT NULL,
	"score" integer NOT NULL,
	"max_combo" integer NOT NULL,
	"timeouts" integer NOT NULL,
	"max_deficit" integer NOT NULL,
	CONSTRAINT "achievement_summary_user_id_match_id_pk" PRIMARY KEY("user_id","match_id")
);
--> statement-breakpoint
CREATE TABLE "earned_badge" (
	"user_id" text NOT NULL,
	"achievement_id" text NOT NULL,
	"unlocked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "earned_badge_user_id_achievement_id_pk" PRIMARY KEY("user_id","achievement_id")
);
--> statement-breakpoint
ALTER TABLE "game_profile" ADD COLUMN "achievements_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "achievement_summary" ADD CONSTRAINT "achievement_summary_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "earned_badge" ADD CONSTRAINT "earned_badge_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;