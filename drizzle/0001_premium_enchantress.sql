CREATE TABLE "game_analysis" (
	"match_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"model" text NOT NULL,
	"document" jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	CONSTRAINT "game_analysis_match_id_version_pk" PRIMARY KEY("match_id","version")
);
--> statement-breakpoint
ALTER TABLE "game_analysis" ADD CONSTRAINT "game_analysis_match_id_game_result_match_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."game_result"("match_id") ON DELETE cascade ON UPDATE no action;