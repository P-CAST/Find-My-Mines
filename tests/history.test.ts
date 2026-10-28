import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { MatchRecord } from "../src/server/game/service";

// Opt-in PostgreSQL verification uses transaction-local temporary tables only.
void test(
  "PostgreSQL migration, atomic replay storage, history privacy and cursor pagination",
  { skip: process.env.GAME_TEST_DATABASE !== "1" },
  async () => {
    const { sql } = await import("drizzle-orm");
    const { db } = await import("../src/server/db");
    const { createHistoryStore } = await import("../src/server/game/history");
    const rollback = new Error("Rollback temporary test tables");
    try {
      await db.transaction(async (tx) => {
        const migration = (
          await readFile(
            new URL("../drizzle/0000_even_mariko_yashida.sql", import.meta.url),
            "utf8",
          )
        )
          .replaceAll("CREATE TABLE ", "CREATE TEMPORARY TABLE ")
          .replaceAll('REFERENCES "public"."user"', 'REFERENCES "user"');
        for (const statement of migration.split("--> statement-breakpoint"))
          if (statement.trim()) await tx.execute(sql.raw(statement));
        await tx.execute(
          sql`insert into "user" (id, name, email, email_verified, created_at, updated_at)
              select id, id, id || '@example.test', false, now(), now()
              from (values ('a'), ('b'), ('outsider')) as users(id)`,
        );
        const store = createHistoryStore(tx);
        const a = await store.profile("a"),
          b = await store.profile("b");
        assert.equal(a.historyPublic, false);
        assert.equal(b.historyPublic, false);
        assert.notEqual(a.publicId, b.publicId);
        const record: MatchRecord = {
          matchId: randomUUID(),
          playerOneId: "a",
          playerTwoId: "b",
          playerOneName: "Alice",
          playerTwoName: "Bob",
          playerOneScore: 11,
          playerTwoScore: 0,
          winnerSeat: 0,
          startedAt: new Date(1000),
          finishedAt: new Date(2000),
          reason: "completed",
          replay: { version: 1, frames: [] },
        };
        await store.saveResult(record);
        await store.saveResult({
          ...record,
          playerOneName: "Must not overwrite",
        });
        assert.equal((await store.history("a", {})).items.length, 1);
        assert.equal((await store.history("b", {})).items.length, 1);
        assert.equal((await store.history("outsider", {})).items.length, 0);
        assert.equal(
          (await store.replay("a", record.matchId)).playerOneName,
          "Alice",
        );
        await assert.rejects(store.replay(null, record.matchId), /private/);
        await assert.rejects(
          store.replay("outsider", record.matchId),
          /private/,
        );
        await assert.rejects(
          store.history(null, { publicId: a.publicId }),
          /private/,
        );
        await store.setVisibility("a", true);
        assert.equal(
          (await store.history(null, { publicId: a.publicId })).items.length,
          0,
        );
        await assert.rejects(store.replay(null, record.matchId), /private/);
        await store.setVisibility("b", true);
        assert.equal(
          (await store.history(null, { publicId: a.publicId })).items.length,
          1,
        );
        assert.deepEqual(
          (await store.replay(null, record.matchId)).replay,
          record.replay,
        );
        assert.equal(
          "playerOneId" in (await store.replay(null, record.matchId)),
          false,
        );
        await store.setVisibility("b", false);
        await assert.rejects(store.replay(null, record.matchId), /private/);
        assert.equal(
          (await store.history(null, { publicId: a.publicId })).items.length,
          0,
        );
        assert.ok(await store.replay("a", record.matchId));
        for (let i = 0; i < 23; i++)
          await store.saveResult({ ...record, matchId: randomUUID() });
        const first = await store.history("a", {});
        assert.equal(first.items.length, 20);
        assert.ok(first.nextCursor);
        const second = await store.history("a", { cursor: first.nextCursor });
        assert.equal(second.items.length, 4);
        assert.equal(second.nextCursor, null);
        assert.equal(
          new Set([...first.items, ...second.items].map((r) => r.matchId)).size,
          24,
        );
        assert.equal(JSON.stringify(first).includes("playerOneId"), false);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      await db.$client.end();
    }
  },
);
