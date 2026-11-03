-- Initial administrator. Password plaintext is delivered privately, never committed.
-- This is a one-time seed; an existing email must fail rather than be promoted.
INSERT INTO "user" ("id", "name", "email", "email_verified", "role", "banned", "created_at", "updated_at")
VALUES ('0c4e3834-45af-4075-8752-ce26efb09087', 'Operator', 'admin@example.com', false, 'admin', false, now(), now());
--> statement-breakpoint
INSERT INTO "account" ("id", "account_id", "provider_id", "user_id", "password", "created_at", "updated_at")
VALUES ('ddc3d151-55b9-418f-9061-dd1ec87e559b', '0c4e3834-45af-4075-8752-ce26efb09087', 'credential', '0c4e3834-45af-4075-8752-ce26efb09087', 'e34d7070ca830301b2552771498ddf6c:5510a582433584c3e609b937ded80896a4bc85c3355a5287e43253641c3ac01ee3ba88e052000451c052c2c8f61a244d39c5ef1eecae417fa0e858f7fe7f47e1', now(), now());
--> statement-breakpoint
INSERT INTO "game_profile" ("user_id") VALUES ('0c4e3834-45af-4075-8752-ce26efb09087');
