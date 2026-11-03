import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  ACHIEVEMENTS,
  achievementProgress,
  type AchievementTotals,
} from "../src/lib/achievements";
import {
  GameService,
  type Actor,
  type MatchCompletion,
  type ServiceOptions,
} from "../src/server/game/service";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const actor = (name: string, userId: string | null = name): Actor => ({
  sessionId: name,
  userId,
  authSessionId: `auth-${name}`,
});
function fixture(options: ServiceOptions = {}) {
  let now = 1000,
    serial = 0;
  const jobs = new Map<number, { at: number; run: () => void }>();
  const writes: MatchCompletion[] = [];
  const service = new GameService({
    now: () => now,
    firstPlayer: () => 0,
    board: () => new Set(Array.from({ length: 11 }, (_, i) => i)),
    log: () => undefined,
    botProvider: async () => {
      throw new Error("Mock bot fallback");
    },
    randomIndex: () => 0,
    saveCompletion: async (completion) => {
      writes.push(completion);
    },
    schedule: (run, ms) => {
      const id = ++serial;
      jobs.set(id, { at: now + ms, run });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (id) => {
      jobs.delete(id as unknown as number);
    },
    ...options,
  });
  function humanRoom(a = actor("a"), b = actor("b")) {
    service.connect(a, null, () => undefined);
    const { roomId } = service.create(a, "A", "public");
    service.connect(a, roomId, () => undefined);
    service.connect(b, roomId, () => undefined);
    service.join(b, roomId, "B");
    return { roomId, a, b };
  }
  function reveal(a: Actor, roomId: string, cellIndex: number) {
    const state = service.snapshot(roomId);
    return service.reveal(a, {
      roomId,
      matchId: state.matchId,
      turnId: state.turnId,
      cellIndex,
    });
  }
  async function advance(ms: number) {
    const target = now + ms;
    for (;;) {
      const next = [...jobs]
        .filter(([, job]) => job.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      jobs.delete(next[0]);
      next[1].run();
      await flush();
    }
    now = target;
    await flush();
  }
  return { service, writes, humanRoom, reveal, advance };
}

void test("all fifteen badges use their exact thresholds and stable IDs", () => {
  assert.equal(ACHIEVEMENTS.length, 15);
  assert.equal(new Set(ACHIEVEMENTS.map((badge) => badge.id)).size, 15);
  const empty: AchievementTotals = {
    mines: 0,
    games: 0,
    combo: 0,
    punctualWins: 0,
    humanWins: 0,
    closeWins: 0,
    comebackWins: 0,
    botWins: 0,
    dominantBotWins: 0,
  };
  for (const badge of ACHIEVEMENTS) {
    for (const amount of [badge.target - 1, badge.target, badge.target + 1]) {
      const progress = achievementProgress({
        ...empty,
        [badge.metric]: amount,
      }).find((entry) => entry.id === badge.id)!;
      assert.equal(
        progress.progress >= progress.target,
        amount >= badge.target,
        badge.id,
      );
      assert.equal(progress.progress, Math.min(amount, badge.target));
    }
  }
});

void test("completion captures both seats, final mine, combos and comeback without leaking boards", async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const { roomId, a, b } = f.humanRoom();
  for (let i = 0; i < 3; i++) f.reveal(a, roomId, i);
  f.reveal(a, roomId, 11);
  for (let i = 3; i < 9; i++) f.reveal(b, roomId, i);
  f.reveal(b, roomId, 12);
  f.reveal(a, roomId, 9);
  f.reveal(a, roomId, 10);
  await flush();
  assert.equal(f.writes.length, 1);
  const [first, second] = f.writes[0]!.summaries;
  assert.equal(first!.score, 5);
  assert.equal(first!.maxCombo, 3);
  assert.equal(first!.won, false);
  assert.equal(second!.score, 6);
  assert.equal(second!.maxCombo, 6);
  assert.equal(second!.maxDeficit, 3);
  assert.equal(second!.won, true);
  assert.deepEqual(
    Object.keys(second!).sort(),
    [
      "userId",
      "matchId",
      "mode",
      "startedAt",
      "finishedAt",
      "won",
      "score",
      "maxCombo",
      "timeouts",
      "maxDeficit",
    ].sort(),
  );
  assert.equal(f.writes[0]!.result!.playerTwoScore, 6);
  assert.equal(
    f.writes[0]!.result!.replay.frames.at(-1)!.state.phase,
    "finished",
  );
});

void test("timeouts end combos and are charged only to the active account; rematches reset tracking", async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const { roomId, a, b } = f.humanRoom();
  f.reveal(a, roomId, 0);
  f.reveal(a, roomId, 1);
  await f.advance(10000);
  f.reveal(b, roomId, 11);
  for (let i = 2; i < 11; i++) f.reveal(a, roomId, i);
  await flush();
  const [first, second] = f.writes[0]!.summaries;
  assert.equal(first!.timeouts, 1);
  assert.equal(first!.maxCombo, 9);
  assert.equal(second!.timeouts, 0);
  const old = f.service.snapshot(roomId).matchId;
  f.service.rematch(a, roomId, old);
  f.service.rematch(b, roomId, old);
  for (let i = 0; i < 11; i++) f.reveal(a, roomId, i);
  await flush();
  assert.notEqual(f.writes[1]!.matchId, old);
  assert.equal(f.writes[1]!.summaries[0]!.timeouts, 0);
  assert.equal(f.writes[1]!.summaries[0]!.maxCombo, 11);
});

void test("guest and mixed games never generate summaries, including login mid-match", async (t) => {
  for (const b of [actor("b", null), actor("b")]) {
    const f = fixture();
    t.after(() => f.service.dispose());
    const { roomId, a } = f.humanRoom(actor("guest", null), b);
    assert.throws(
      () => f.reveal({ ...a, userId: "new-login" }, roomId, 0),
      /seat/,
    );
    for (let i = 0; i < 11; i++) f.reveal(a, roomId, i);
    await flush();
    assert.equal(f.writes.length, 0);
  }
});

void test("forfeits save only human history; reset and abandonment never award achievements", async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const { roomId, a } = f.humanRoom();
  f.reveal(a, roomId, 0);
  f.service.leave(a, roomId);
  await flush();
  assert.equal(f.writes[0]!.result!.reason, "forfeit");
  assert.deepEqual(f.writes[0]!.summaries, []);
  const other = f.humanRoom(actor("c"), actor("d"));
  f.reveal(other.a, other.roomId, 0);
  f.service.reset(other.roomId);
  await flush();
  assert.equal(f.writes.length, 1);
  f.service.start(other.roomId);
  await f.advance(31000);
  assert.equal(f.writes.length, 1);
});

void test("bot games persist only signed-in human facts; bot fallback moves count normally", async (t) => {
  for (const signedIn of [true, false]) {
    const f = fixture({ firstPlayer: () => 1 });
    t.after(() => f.service.dispose());
    const a = actor("human", signedIn ? "account" : null);
    f.service.connect(a, null, () => undefined);
    const { roomId } = f.service.createBot(a, "Human");
    f.service.connect(a, roomId, () => undefined);
    await f.advance(0);
    assert.equal(f.service.snapshot(roomId).phase, "finished");
    assert.equal(f.service.snapshot(roomId).saveStatus, "unrecorded");
    if (signedIn) {
      assert.equal(f.writes.length, 1);
      assert.equal(f.writes[0]!.result, undefined);
      assert.equal(f.writes[0]!.summaries.length, 1);
      assert.equal(f.writes[0]!.summaries[0]!.mode, "bot");
      assert.equal(f.writes[0]!.summaries[0]!.score, 0);
      assert.equal(f.writes[0]!.summaries[0]!.maxDeficit, 11);
    } else assert.equal(f.writes.length, 0);
  }
});

void test("signed-in bot winners receive their own final score and no saved result", async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const a = actor("human");
  f.service.connect(a, null, () => undefined);
  const { roomId } = f.service.createBot(a, "Human");
  f.service.connect(a, roomId, () => undefined);
  for (let i = 0; i < 11; i++) f.reveal(a, roomId, i);
  await flush();
  assert.equal(f.writes[0]!.result, undefined);
  assert.equal(f.writes[0]!.summaries[0]!.won, true);
  assert.equal(f.writes[0]!.summaries[0]!.score, 11);
  assert.equal(f.writes[0]!.summaries[0]!.maxCombo, 11);
  assert.equal(f.writes[0]!.summaries[0]!.mode, "bot");
});

void test("failed achievement writes retry after room disposal with the same immutable completion", async (t) => {
  const attempts: MatchCompletion[] = [];
  const f = fixture({
    saveCompletion: async (completion) => {
      attempts.push(structuredClone(completion));
      if (attempts.length === 1) {
        completion.summaries[0]!.score = 0;
        throw new Error("offline");
      }
    },
  });
  t.after(() => f.service.dispose());
  const { roomId, a, b } = f.humanRoom();
  for (let i = 0; i < 11; i++) f.reveal(a, roomId, i);
  await flush();
  assert.equal(f.service.clients().failedSaves, 1);
  f.service.leave(a, roomId);
  f.service.leave(b, roomId);
  await f.advance(5000);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(f.service.clients().pendingSaves, 0);
});

void test(
  "PostgreSQL achievement persistence, mode rules, privacy, rollback and deletion",
  { skip: process.env.GAME_TEST_DATABASE !== "1" },
  async () => {
    const { sql } = await import("drizzle-orm");
    const { db } = await import("../src/server/db");
    const { createHistoryStore } = await import("../src/server/game/history");
    const { createAchievementStore } =
      await import("../src/server/game/achievements");
    const { gameRouter } = await import("../src/server/api/routers/game");
    const anonymous = gameRouter.createCaller({
      db,
      headers: new Headers(),
      responseHeaders: new Headers(),
      session: null,
      gameSession: {
        id: randomUUID(),
        secure: false,
        guestName: null,
      },
    });
    await assert.rejects(
      anonymous.achievements(),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "UNAUTHORIZED",
    );
    await assert.rejects(
      anonymous.setAchievementVisibility({ achievementsPublic: true }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "UNAUTHORIZED",
    );
    const rollback = new Error("Rollback temporary achievement tables");
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
          sql`insert into "user" (id,name,email,email_verified,created_at,updated_at) select id,id,id || '@example.test',false,now(),now() from (values ('a'),('b'),('outsider')) as users(id)`,
        );
        const history = createHistoryStore(tx),
          badges = createAchievementStore(tx);
        const fact = {
          userId: "a",
          matchId: randomUUID(),
          mode: "bot" as const,
          startedAt: new Date(1000),
          finishedAt: new Date(2000),
          won: true,
          score: 11,
          maxCombo: 11,
          timeouts: 0,
          maxDeficit: 0,
        };
        const completion = { matchId: fact.matchId, summaries: [fact] };
        await history.saveCompletion(completion);
        await history.saveCompletion(completion);
        let own = await badges.own("a");
        assert.equal(
          own.catalogue.find((b) => b.id === "regular-explorer")!.progress,
          1,
        );
        assert.ok(own.badges.some((b) => b.id === "outclassed"));
        assert.ok(!own.badges.some((b) => b.id === "friendly-rival"));
        assert.equal(own.achievementsPublic, false);
        await assert.rejects(badges.publicCollection(own.publicId), /private/);
        const originalDate = own.badges.find(
          (b) => b.id === "first-discovery",
        )!.unlockedAt;
        for (let i = 0; i < 4; i++) {
          const matchId = randomUUID();
          await history.saveCompletion({
            matchId,
            summaries: [{ ...fact, matchId, finishedAt: new Date(3000 + i) }],
          });
        }
        own = await badges.own("a");
        assert.ok(own.badges.some((b) => b.id === "practice-champion"));
        assert.deepEqual(
          own.badges.find((b) => b.id === "first-discovery")!.unlockedAt,
          originalDate,
        );
        await badges.setVisibility("a", true);
        const publicData = await badges.publicCollection(own.publicId);
        assert.deepEqual(Object.keys(publicData), ["badges"]);
        assert.deepEqual(Object.keys(publicData.badges[0]!).sort(), [
          "id",
          "unlockedAt",
        ]);
        await assert.rejects(
          history.history(null, { publicId: own.publicId }),
          /private/,
        );
        await badges.setVisibility("a", false);
        await assert.rejects(badges.publicCollection(own.publicId), /private/);
        const empty = await badges.own("outsider");
        await badges.setVisibility("outsider", true);
        assert.deepEqual(await badges.publicCollection(empty.publicId), {
          badges: [],
        });
        const matchId = randomUUID();
        const human = {
          ...fact,
          matchId,
          mode: "human" as const,
          score: 6,
          maxDeficit: 3,
          maxCombo: 2,
          timeouts: 1,
        };
        const result = {
          matchId,
          playerOneId: "a",
          playerTwoId: "b",
          playerOneName: "A",
          playerTwoName: "B",
          playerOneScore: 6,
          playerTwoScore: 5,
          winnerSeat: 0,
          startedAt: fact.startedAt,
          finishedAt: fact.finishedAt,
          reason: "completed" as const,
          replay: { version: 1 as const, frames: [] },
        };
        await history.saveCompletion({
          matchId,
          result,
          summaries: [human, { ...human, userId: "b", won: false, score: 5 }],
        });
        own = await badges.own("a");
        for (const id of ["friendly-rival", "by-a-whisker", "comeback"])
          assert.ok(own.badges.some((b) => b.id === id));
        assert.equal(
          (await badges.own("b")).badges.some((b) => b.id === "friendly-rival"),
          false,
        );
        // Bot wins never count as human wins; ten human wins finish the full catalogue.
        assert.equal(
          own.catalogue.find((badge) => badge.id === "proven-rival")!.progress,
          1,
        );
        for (let i = 0; i < 9; i++) {
          const matchId = randomUUID();
          await history.saveCompletion({
            matchId,
            summaries: [{ ...human, matchId }],
          });
        }
        own = await badges.own("a");
        assert.equal(own.badges.length, 15);
        for (const badge of own.catalogue)
          assert.equal(badge.progress, badge.target, badge.id);
        assert.equal((await history.history("a", {})).items.length, 1);
        assert.equal(
          (await badges.own("b")).badges.some(
            (badge) => badge.id === "on-the-clock",
          ),
          false,
        );
        const before = own.catalogue;
        const badMatch = randomUUID();
        await assert.rejects(
          history.saveCompletion({
            matchId: badMatch,
            result: { ...result, matchId: badMatch },
            summaries: [
              { ...human, matchId: badMatch },
              { ...human, userId: "b", maxCombo: 0.5, matchId: badMatch },
            ],
          }),
        );
        assert.deepEqual((await badges.own("a")).catalogue, before);
        await assert.rejects(history.replay("a", badMatch), /private/);
        await tx.execute(sql`delete from "user" where id = 'b'`);
        assert.deepEqual((await badges.own("a")).badges, own.badges);
        await tx.execute(sql`delete from "user" where id = 'a'`);
        const rows = await tx.execute(
          sql`select * from "earned_badge" where user_id = 'a'`,
        );
        assert.equal(rows.length, 0);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      await db.$client.end({ timeout: 1 });
    }
  },
);
