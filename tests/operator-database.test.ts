import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { isOperator, requireOperatorAccount } from "../src/lib/operator";

void test(
  "PostgreSQL administrator migration and Better Auth authorization",
  {
    skip: process.env.GAME_TEST_DATABASE !== "1",
  },
  async () => {
    const { sql } = await import("drizzle-orm");
    const { betterAuth } = await import("better-auth");
    const { drizzleAdapter } = await import("better-auth/adapters/drizzle");
    const { auth: configuredAuth } =
      await import("../src/server/better-auth/config");
    const { db } = await import("../src/server/db");
    const rollback = new Error("Rollback temporary operator tables");
    try {
      await db.transaction(async (tx) => {
        const journal = JSON.parse(
          await readFile(
            new URL("../drizzle/meta/_journal.json", import.meta.url),
            "utf8",
          ),
        ) as { entries: { tag: string }[] };
        for (const { tag } of journal.entries) {
          if (tag === "0005_better_auth_admin") {
            await tx.execute(
              sql`insert into "user" (id, name, email, email_verified, created_at, updated_at) values ('legacy', 'Legacy', 'legacy@example.test', false, now(), now())`,
            );
          }
          const migration = (
            await readFile(
              new URL(`../drizzle/${tag}.sql`, import.meta.url),
              "utf8",
            )
          )
            .replaceAll("CREATE TABLE ", "CREATE TEMPORARY TABLE ")
            .replaceAll('REFERENCES "public".', "REFERENCES ");
          for (const statement of migration.split("--> statement-breakpoint"))
            if (statement.trim()) await tx.execute(sql.raw(statement));
        }
        const legacy = await tx.execute(
          sql`select role from "user" where id = 'legacy'`,
        );
        assert.equal(legacy[0]?.role, "user");
        const auth = betterAuth({
          ...configuredAuth.options,
          baseURL: "http://localhost:3000",
          secret: "operator-test-only-secret-of-sufficient-length",
          database: drizzleAdapter(tx, {
            provider: "pg",
            schema: await import("../src/server/db/schema"),
          }),
        });
        const rejectedSignup = await auth.handler(
          new Request("http://localhost:3000/api/auth/sign-up/email", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "http://localhost:3000",
            },
            body: JSON.stringify({
              name: "Normal user",
              email: "normal@example.test",
              password: "normal-test-password",
              role: "admin",
              banned: false,
            }),
          }),
        );
        assert.equal(rejectedSignup.status, 400);
        assert.equal(
          ((await rejectedSignup.json()) as { code: string }).code,
          "FIELD_NOT_ALLOWED",
        );
        const response = await auth.api.signUpEmail({
          body: {
            name: "Normal user",
            email: "normal@example.test",
            password: "normal-test-password",
          },
          asResponse: true,
        });
        assert.equal(response.status, 200);
        const headers = new Headers({
          cookie: response.headers
            .getSetCookie()
            .map((value) => value.split(";")[0])
            .join("; "),
        });
        const readSession = () =>
          auth.api.getSession({
            headers,
            query: { disableCookieCache: true, disableRefresh: true },
          });
        let session = await readSession();
        assert.ok(session);
        assert.equal(session.user.role, "user");
        assert.throws(
          () => requireOperatorAccount(session),
          /Administrator access/,
        );
        const userId = session.user.id;
        const update = await auth.handler(
          new Request("http://localhost:3000/api/auth/update-user", {
            method: "POST",
            headers: {
              cookie: headers.get("cookie")!,
              "content-type": "application/json",
              origin: "http://localhost:3000",
            },
            body: JSON.stringify({ name: "Updated name", role: "admin" }),
          }),
        );
        assert.equal(update.status, 400);
        assert.equal((await readSession())?.user.role, "user");
        await tx.execute(
          sql`update "user" set role = 'admin' where id = ${userId}`,
        );
        session = await readSession();
        assert.equal(isOperator(session?.user), true);
        await tx.execute(
          sql`update "user" set banned = true where id = ${userId}`,
        );
        assert.equal(isOperator((await readSession())?.user), false);
        await tx.execute(
          sql`update "user" set banned = false, role = 'user' where id = ${userId}`,
        );
        assert.equal(isOperator((await readSession())?.user), false);
        await tx.execute(sql`delete from "session" where user_id = ${userId}`);
        assert.equal(await readSession(), null);
        // Reuse a correctly signed cookie, then expire the corresponding persisted session.
        const login = await auth.api.signInEmail({
          body: {
            email: "normal@example.test",
            password: "normal-test-password",
          },
          asResponse: true,
        });
        const loginHeaders = new Headers({
          cookie: login.headers
            .getSetCookie()
            .map((value) => value.split(";")[0])
            .join("; "),
        });
        await tx.execute(
          sql`update "session" set expires_at = now() - interval '1 day' where user_id = ${userId}`,
        );
        assert.equal(
          await auth.api.getSession({
            headers: loginHeaders,
            query: { disableCookieCache: true, disableRefresh: true },
          }),
          null,
        );
        const seeded = await tx.execute(
          sql`select u.id, a.provider_id, a.password from "user" u join "account" a on a.user_id = u.id join "game_profile" p on p.user_id = u.id where u.role = 'admin'`,
        );
        assert.equal(seeded.length, 1);
        assert.equal(seeded[0]?.provider_id, "credential");
        assert.equal(typeof seeded[0]?.password, "string");

        const seed = await readFile(
          new URL("../drizzle/0006_seed_operator.sql", import.meta.url),
          "utf8",
        );
        const seedUser = seed.split("--> statement-breakpoint")[0]!;
        const restoreSeed = new Error("Restore seeded administrator");
        try {
          await tx.transaction(async (nested) => {
            await nested.execute(
              sql`delete from "user" where email = 'admin@example.com'`,
            );
            await nested.execute(
              sql`insert into "user" (id, name, email, email_verified, role, created_at, updated_at) values ('collision', 'Ordinary user', 'admin@example.com', false, 'user', now(), now())`,
            );
            await assert.rejects(
              nested.transaction(async (attempt) => {
                await attempt.execute(sql.raw(seedUser));
              }),
            );
            const unchanged = await nested.execute(
              sql`select role from "user" where id = 'collision'`,
            );
            assert.equal(unchanged[0]?.role, "user");
            throw restoreSeed;
          });
        } catch (error) {
          if (error !== restoreSeed) throw error;
        }

        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      await db.$client.end();
    }
  },
);
