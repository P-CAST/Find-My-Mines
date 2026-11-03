CREATE TABLE "friendship" (
	"account_one" text NOT NULL,
	"account_two" text NOT NULL,
	"requester" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "friendship_account_one_account_two_pk" PRIMARY KEY("account_one","account_two"),
	CONSTRAINT "friendship_order" CHECK ("friendship"."account_one" collate "C" < "friendship"."account_two" collate "C"),
	CONSTRAINT "friendship_requester" CHECK ("friendship"."requester" in ("friendship"."account_one", "friendship"."account_two")),
	CONSTRAINT "friendship_status" CHECK ("friendship"."status" in ('pending', 'accepted'))
);
--> statement-breakpoint
ALTER TABLE "friendship" ADD CONSTRAINT "friendship_account_one_user_id_fk" FOREIGN KEY ("account_one") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "friendship" ADD CONSTRAINT "friendship_account_two_user_id_fk" FOREIGN KEY ("account_two") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "friendship_account_two_idx" ON "friendship" USING btree ("account_two");--> statement-breakpoint
INSERT INTO "game_profile" ("user_id") SELECT "id" FROM "user" ON CONFLICT DO NOTHING;
