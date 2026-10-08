import assert from "node:assert/strict";
import { test } from "node:test";
import { GameService } from "../src/server/game/service";
import {
  adjacentBombs,
  generateBoard,
  GRACE_MS,
  LEASE_MS,
  TURN_MS,
} from "../src/server/game/rules";

function fixture() {
  let now = 1_000;
  let timerId = 0;
  const jobs = new Map<number, { at: number; fn: () => void }>();
  const callbacks: (() => void)[] = [];
  let boards = 0;
  const game = new GameService({
    now: () => now,
    firstPlayer: () => 0,
    log: () => undefined,
    board: () => {
      boards++;
      return new Set(
        Array.from({ length: 11 }, (_, i) => i + (boards > 1 ? 11 : 0)),
      );
    },
    schedule: (fn, ms) => {
      jobs.set(++timerId, { at: now + ms, fn });
      callbacks.push(fn);
      return timerId as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (id) => {
      jobs.delete(id as unknown as number);
    },
  });
  const closeA = game.connect("a", () => undefined);
  const closeB = game.connect("b", () => undefined);
  game.join("a", "Alice");
  game.join("b", "Bob");
  const advance = (ms: number, run = true) => {
    now += ms;
    if (run)
      for (const [id, job] of [...jobs])
        if (job.at <= now) {
          jobs.delete(id);
          job.fn();
        }
  };
  const reveal = (id: string, cellIndex: number) => {
    const s = game.snapshot();
    return game.reveal(id, { matchId: s.matchId, turnId: s.turnId, cellIndex });
  };
  return { game, advance, reveal, jobs, callbacks, closeA, closeB };
}

void test("generation has exactly eleven distinct, in-bounds bombs", () => {
  const boards = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const board = generateBoard();
    assert.equal(board.size, 11);
    assert.ok([...board].every((n) => Number.isInteger(n) && n >= 0 && n < 36));
    boards.add([...board].sort().join(","));
  }
  assert.ok(boards.size > 1);
});
void test("neighbor counts respect corners, edges, diagonals and row boundaries", () => {
  const bombs = new Set([1, 6, 7, 4, 10, 11, 28, 29, 34]);
  assert.equal(adjacentBombs(bombs, 0), 3);
  assert.equal(adjacentBombs(bombs, 5), 3);
  assert.equal(adjacentBombs(bombs, 35), 3);
  assert.equal(adjacentBombs(bombs, 2), 2);
  assert.equal(adjacentBombs(new Set([0, 1, 2, 6, 8, 12, 13, 14]), 7), 8);
  assert.equal(adjacentBombs(new Set([5, 11]), 6), 0);
});
void test("a bomb scores once and preserves player, turn ID and original deadline", () => {
  const f = fixture();
  const before = f.game.snapshot();
  f.advance(3000);
  const after = f.reveal("a", 0);
  assert.equal(after.players[0]!.score, 1);
  assert.equal(after.deadline, before.deadline);
  assert.equal(after.turnId, before.turnId);
  assert.equal(after.activePlayer, "a");
  assert.throws(() => f.reveal("a", 0), /already/);
  assert.equal(f.game.snapshot().players[0]!.score, 1);
  f.game.dispose();
});
void test("empty reveals only one numbered cell and gives opponent a fresh turn", () => {
  const f = fixture();
  const before = f.game.snapshot();
  f.advance(2000);
  const after = f.reveal("a", 12);
  assert.deepEqual(after.cells[12], { kind: "empty", adjacent: 2 });
  assert.equal(after.cells.filter((c) => c.kind !== "covered").length, 1);
  assert.equal(after.activePlayer, "b");
  assert.equal(after.deadline, before.deadline! + 2000);
  assert.notEqual(after.turnId, before.turnId);
  f.game.dispose();
});
void test("server timeout advances turn with no requests; stale callback cannot advance it twice", () => {
  const f = fixture();
  const before = f.game.snapshot();
  const callbacks = [...f.callbacks];
  f.advance(TURN_MS);
  assert.equal(f.game.snapshot().activePlayer, "b");
  assert.notEqual(f.game.snapshot().turnId, before.turnId);
  callbacks.forEach((fn) => fn());
  assert.equal(f.game.snapshot().activePlayer, "b");
  f.game.dispose();
});
void test("rejects unseated, out-of-turn, invalid, stale and expired selections even when timer is delayed", () => {
  const f = fixture();
  const s = f.game.snapshot();
  const input = { matchId: s.matchId, turnId: s.turnId, cellIndex: 0 };
  assert.throws(() => f.game.reveal("stranger", input), /seat/);
  assert.throws(() => f.game.reveal("b", input), /not your turn/);
  assert.throws(() => f.reveal("a", -1), /Invalid/);
  assert.throws(() => f.reveal("a", 36), /Invalid/);
  assert.throws(() => f.reveal("a", 0.5), /Invalid/);
  f.advance(TURN_MS, false);
  assert.throws(() => f.game.reveal("a", input), /expired/);
  assert.equal(f.game.snapshot().players[0]!.score, 0);
  assert.equal(f.game.snapshot().activePlayer, "b");
  f.game.reset();
  assert.throws(() => f.game.reveal("a", input), /not active/);
  f.game.dispose();
});
void test("eleventh bomb ends match, cancels timer, and two votes start a fresh winner-first board", () => {
  const f = fixture();
  f.reveal("a", 20); // Bob wins despite Alice initially starting.
  for (let i = 0; i < 10; i++) {
    f.reveal("b", i);
    assert.equal(f.game.snapshot().phase, "active");
  }
  const final = f.reveal("b", 10);
  assert.equal(final.phase, "finished");
  assert.equal(final.winner, "b");
  assert.equal(final.deadline, null);
  assert.equal(f.jobs.size, 2); // only the two presence leases
  f.game.rematch("a", final.matchId);
  f.game.rematch("a", final.matchId);
  assert.equal(f.game.snapshot().rematchVotes.length, 1);
  const next = f.game.rematch("b", final.matchId);
  assert.equal(next.phase, "active");
  assert.equal(next.activePlayer, "b");
  assert.notEqual(next.matchId, final.matchId);
  assert.equal(
    next.players.reduce((sum, p) => sum + p.score, 0),
    0,
  );
  assert.deepEqual(next.rematchVotes, []);
  assert.ok(next.cells.every((c) => c.kind === "covered"));
  assert.throws(() => f.game.rematch("b", final.matchId), /no longer/);
  assert.equal(f.reveal("b", 0).cells[0]!.kind, "empty");
  f.game.dispose();
});
void test("reset retains connected seats, invalidates pending callbacks and needs explicit start", () => {
  const f = fixture();
  f.reveal("a", 0);
  const s = f.game.snapshot();
  const callbacks = [...f.callbacks];
  const reset = f.game.reset();
  assert.equal(reset.players.length, 2);
  assert.equal(reset.phase, "lobby");
  assert.equal(reset.manualStart, true);
  assert.equal(reset.winner, null);
  assert.equal(reset.deadline, null);
  assert.equal(reset.players[0]!.score, 0);
  assert.ok(reset.cells.every((c) => c.kind === "covered"));
  callbacks.forEach((fn) => fn());
  assert.equal(f.game.snapshot().phase, "lobby");
  const next = f.game.start();
  assert.notEqual(next.matchId, s.matchId);
  assert.throws(
    () =>
      f.game.reveal("a", {
        matchId: s.matchId,
        turnId: s.turnId,
        cellIndex: 1,
      }),
    /expired/,
  );
  f.game.dispose();
});
void test("streams are reference-counted, visitors counted, and reconnect preserves seat during grace", () => {
  const f = fixture();
  const closeTab = f.game.connect("a", () => undefined);
  f.closeA();
  assert.equal(f.game.clients().count, 2);
  closeTab();
  assert.equal(f.game.clients().count, 1);
  assert.equal(f.game.snapshot().players[0]!.reservedUntil !== null, true);
  f.advance(1000);
  const close = f.game.connect("a", () => undefined);
  assert.equal(f.game.snapshot().players[0]!.reservedUntil, null);
  const visitor = f.game.connect("visitor", () => undefined);
  assert.equal(f.game.clients().count, 3);
  assert.equal(f.game.clients().clients[2]!.nickname, "Not joined");
  assert.throws(() => f.game.join("visitor", "Third"), /Game full/);
  visitor();
  close();
  f.game.dispose();
});
void test("grace expiry aborts without a winner and invalidates old actions/timers", () => {
  const f = fixture();
  f.reveal("a", 0);
  const s = f.game.snapshot();
  f.closeA();
  f.advance(GRACE_MS - 1, false);
  f.game.heartbeat("b");
  f.advance(1);
  const after = f.game.snapshot();
  assert.equal(after.phase, "lobby");
  assert.equal(after.players.length, 1);
  assert.equal(after.players[0]!.id, "b");
  assert.equal(after.players[0]!.score, 0);
  assert.equal(after.winner, null);
  assert.equal(after.deadline, null);
  assert.notEqual(after.matchId, s.matchId);
  assert.deepEqual(after.rematchVotes, []);
  assert.throws(
    () =>
      f.game.reveal("a", {
        matchId: s.matchId,
        turnId: s.turnId,
        cellIndex: 1,
      }),
    /seat/,
  );
  f.game.dispose();
});
void test("abrupt network loss expires the heartbeat lease then reserves the seat", () => {
  const f = fixture();
  let closed = false;
  f.game.connect("a", () => {
    closed = true;
  });
  f.advance(LEASE_MS);
  assert.equal(closed, true);
  assert.equal(f.game.clients().count, 0);
  assert.equal(f.game.snapshot().players.length, 2);
  f.advance(GRACE_MS);
  assert.equal(f.game.snapshot().players.length, 0);
  assert.equal(f.game.snapshot().phase, "lobby");
  f.game.dispose();
});
void test("public snapshots reveal no hidden bomb positions and cannot mutate authority", () => {
  const f = fixture();
  const s = f.game.snapshot();
  assert.ok(s.cells.every((c) => JSON.stringify(c) === '{"kind":"covered"}'));
  assert.equal("bombs" in s, false);
  assert.equal("board" in s, false);
  assert.equal(JSON.stringify(f.game.clients()).includes('"bombs"'), false);
  s.players[0]!.score = 100;
  s.cells[0] = { kind: "bomb" };
  assert.equal(f.game.snapshot().players[0]!.score, 0);
  assert.equal(f.game.snapshot().cells[0]!.kind, "covered");
  f.game.dispose();
});

void test("a completed two-party vote starts automatically when the first voter reconnects", () => {
  const f = fixture();
  for (let i = 0; i < 11; i++) f.reveal("a", i);
  const match = f.game.snapshot().matchId;
  f.game.rematch("a", match);
  f.closeA();
  f.game.rematch("b", match);
  assert.equal(f.game.snapshot().phase, "finished");
  f.game.connect("a", () => undefined);
  assert.equal(f.game.snapshot().phase, "active");
  assert.equal(f.game.snapshot().activePlayer, "a");
  f.game.dispose();
});
