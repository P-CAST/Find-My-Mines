import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { SavedAnalysis } from "../src/server/game/analysis";
import type { MatchRecord } from "../src/server/game/service";

// Opt-in PostgreSQL verification uses transaction-local temporary tables only.
void test(
  "PostgreSQL migration, atomic replay storage, history privacy and cursor pagination",
  { skip: process.env.GAME_TEST_DATABASE !== "1" },
  async () => {
    const { sql } = await import("drizzle-orm");
    const { db } = await import("../src/server/db");
    const { createHistoryStore } = await import("../src/server/game/history");
    const { createRatingStore } = await import("../src/server/game/ratings");
    const rollback = new Error("Rollback temporary test tables");
    try {
      await db.transaction(async (tx) => {
        for (const filename of [
          "0000_even_mariko_yashida.sql",
          "0001_premium_enchantress.sql",
          "0002_stormy_spitfire.sql",
          "0003_soft_psynapse.sql",
          "0004_white_tomas.sql",
        ]) {
          const migration = (
            await readFile(
              new URL(`../drizzle/${filename}`, import.meta.url),
              "utf8",
            )
          )
            .replaceAll("CREATE TABLE ", "CREATE TEMPORARY TABLE ")
            .replaceAll('REFERENCES "public".', "REFERENCES ");
          for (const statement of migration.split("--> statement-breakpoint"))
            if (statement.trim()) await tx.execute(sql.raw(statement));
        }
        await tx.execute(
          sql`insert into "user" (id, name, email, email_verified, created_at, updated_at)
              select id, id, id || '@example.test', false, now(), now()
              from (values ('a'), ('b'), ('outsider')) as users(id)`,
        );
        const store = createHistoryStore(tx);
        const ratings = createRatingStore(tx);
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
        assert.equal((await ratings.own("a")).rating, 1016);
        assert.equal((await ratings.own("b")).rating, 984);
        assert.equal((await ratings.own("a")).games, 1);
        assert.deepEqual(await ratings.match("a", record.matchId), {
          before: 1000,
          after: 1016,
          delta: 16,
        });
        await assert.rejects(
          ratings.match("outsider", record.matchId),
          /unavailable/,
        );
        assert.equal((await ratings.own("outsider")).rank, null);
        const board = await ratings.leaderboard(0);
        assert.equal(board.items[0]?.rank, 1);
        assert.equal(board.items[1]?.rating, 984);
        assert.equal(JSON.stringify(board).includes("userId"), false);
        assert.equal(JSON.stringify(board).includes("email"), false);
        // A rolled-back completion must leave neither ratings nor a result.
        const failedId = randomUUID();
        await assert.rejects(
          tx.transaction(async (nested) => {
            await createHistoryStore(nested).saveResult({
              ...record,
              matchId: failedId,
            });
            throw new Error("injected rollback");
          }),
          /injected rollback/,
        );
        assert.equal((await ratings.own("a")).rating, 1016);
        await assert.rejects(ratings.match("a", failedId), /unavailable/);
        // Exercise a forfeit and a retry in a savepoint, then restore the fixture.
        const restore = new Error("restore fixture");
        try {
          await tx.transaction(async (nested) => {
            const nestedStore = createHistoryStore(nested);
            const next = {
              ...record,
              matchId: failedId,
              reason: "forfeit" as const,
            };
            await nestedStore.saveResult(next);
            await nestedStore.saveResult(next);
            assert.equal(
              (await createRatingStore(nested).own("a")).rating,
              1031,
            );
            assert.equal(
              (await createRatingStore(nested).own("b")).rating,
              969,
            );
            throw restore;
          });
        } catch (error) {
          if (error !== restore) throw error;
        }
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
        const analysis: SavedAnalysis = {
          matchId: record.matchId,
          version: 1,
          model: "test-model",
          generatedAt: new Date(),
          inputTokens: 10,
          outputTokens: 20,
          document: {
            report: {
              summary: "Test summary",
              keyMoments: [],
              coaching: [
                { seat: 0, tips: [] },
                { seat: 1, tips: [] },
              ],
            },
            statistics: {
              players: [],
              turnChanges: 0,
              durationMs: 1000,
              winnerSeat: 0,
              reason: "completed",
            },
          },
        };
        await store.saveAnalysis(analysis);
        await store.saveAnalysis({ ...analysis, model: "must-not-overwrite" });
        assert.equal(
          (await store.readAnalysis("a", record.matchId, 1))?.model,
          "test-model",
        );
        assert.equal(
          (await store.readAnalysis("b", record.matchId, 1))?.model,
          "test-model",
        );
        assert.equal(await store.readAnalysis(null, record.matchId, 1), null);
        assert.equal(
          (await store.analysisSource("a", record.matchId, true)).isParticipant,
          true,
        );
        await assert.rejects(
          store.analysisSource("outsider", record.matchId, true),
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
        assert.ok(await store.readAnalysis(null, record.matchId, 1));
        assert.equal(
          (await store.analysisSource(null, record.matchId)).isParticipant,
          false,
        );
        await assert.rejects(
          store.analysisSource("outsider", record.matchId, true),
        );
        await store.setVisibility("b", false);
        assert.equal(await store.readAnalysis(null, record.matchId, 1), null);
        assert.ok(await store.readAnalysis("a", record.matchId, 1));
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
        await tx.execute(
          sql`delete from "game_result" where match_id = ${record.matchId}`,
        );
        const orphaned = await tx.execute(
          sql`select count(*)::int as count from "game_analysis" where match_id = ${record.matchId}`,
        );
        assert.equal(orphaned[0]?.count, 0);
        // Legacy results remain unrated; public ranks do not depend on history consent.
        await tx.execute(
          sql`update game_result set player_one_rating_before = null, player_one_rating_after = null, player_two_rating_before = null, player_two_rating_after = null`,
        );
        const remaining = (await store.history("a", {})).items[0]!;
        assert.equal(await ratings.match("a", remaining.matchId), null);
        await store.saveResult({ ...record, matchId: remaining.matchId });
        assert.equal(await ratings.match("a", remaining.matchId), null);
        await tx.execute(
          sql`update game_profile set rating = 1000 where user_id in ('a', 'b')`,
        );
        const tied = await ratings.leaderboard(0);
        assert.deepEqual(
          tied.items.map((p) => p.rank),
          [1, 1],
        );
        assert.deepEqual(
          tied.items.map((p) => p.publicId),
          tied.items.map((p) => p.publicId).sort(),
        );
        await tx.execute(sql`insert into "user" (id, name, email, email_verified, created_at, updated_at)
          select 'rank-' || i, 'Rank ' || i, 'rank-' || i || '@example.test', false, now(), now() from generate_series(1, 51) i`);
        await tx.execute(sql`insert into game_profile (user_id, rating, rated_games, rated_wins, rated_losses)
          select 'rank-' || i, 900, 1, 0, 1 from generate_series(1, 51) i`);
        const firstRanks = await ratings.leaderboard(0),
          secondRanks = await ratings.leaderboard(1);
        assert.equal(firstRanks.items.length, 50);
        assert.equal(firstRanks.hasNextPage, true);
        assert.equal(secondRanks.items.length, 3);
        assert.equal(secondRanks.hasNextPage, false);
        assert.equal(secondRanks.items[0]?.rank, 3);
        assert.equal(
          new Set(
            [...firstRanks.items, ...secondRanks.items].map((p) => p.publicId),
          ).size,
          53,
        );
        const survivor = await ratings.own("b");
        await tx.execute(sql`delete from "user" where id = 'a'`);
        assert.equal((await ratings.own("b")).rating, survivor.rating);
        assert.equal((await ratings.own("b")).games, survivor.games);
        assert.equal(
          (await ratings.leaderboard(0)).items.some(
            (p) => p.publicId === a.publicId,
          ),
          false,
        );
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      await db.$client.end();
    }
  },
);
