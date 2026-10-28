import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACCOUNT_WAIT_MS,
  GameService,
  type Actor,
  type MatchRecord,
} from "../src/server/game/service";
import { gameStream } from "../src/server/game/stream";

const actor = (sessionId: string, userId: string | null = null): Actor => ({
  sessionId,
  userId,
  ...(userId ? { authSessionId: `auth-${sessionId}` } : {}),
});
function fixture(saveResult?: (record: MatchRecord) => Promise<void>) {
  let now = 1000,
    nextTimer = 0;
  const jobs = new Map<number, { at: number; run: () => void }>();
  const records: MatchRecord[] = [];
  const service = new GameService({
    now: () => now,
    firstPlayer: () => 0,
    board: () => new Set(Array.from({ length: 11 }, (_, i) => i)),
    log: () => undefined,
    saveResult:
      saveResult ??
      (async (record) => {
        records.push(record);
      }),
    schedule: (run, ms) => {
      const id = ++nextTimer;
      jobs.set(id, { at: now + ms, run });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (timer) => {
      jobs.delete(timer as unknown as number);
    },
  });
  const advance = (ms: number, actors: Actor[] = []) => {
    const target = now + ms;
    while (now < target) {
      now = Math.min(target, now + 1000);
      if (now % 5000 === 0)
        for (const a of actors) {
          const roomId = service.lobby(a).roomId;
          const snapshot = roomId ? service.snapshot(roomId, a) : undefined;
          const inRoom = snapshot?.players.some(
            (p) => p.id === snapshot.viewerId && p.connected,
          );
          service.heartbeat(a, inRoom ? roomId : null);
        }
      for (const [id, job] of [...jobs])
        if (jobs.has(id) && job.at <= now) {
          jobs.delete(id);
          job.run();
        }
    }
  };
  const lobby = (a: Actor) => service.connect(a, null, () => undefined);
  const room = (
    a: Actor,
    b: Actor,
    visibility: "public" | "unlisted" = "public",
  ) => {
    const closeLobby = lobby(a);
    const { roomId } = service.create(a, "Alice", visibility);
    const closeA = service.connect(a, roomId, () => undefined);
    closeLobby();
    const closeB = service.connect(b, roomId, () => undefined);
    service.join(b, roomId, "Bob");
    return { roomId, closeA, closeB };
  };
  const reveal = (a: Actor, roomId: string, cellIndex: number) => {
    const s = service.snapshot(roomId);
    return service.reveal(a, {
      roomId,
      matchId: s.matchId,
      turnId: s.turnId,
      cellIndex,
    });
  };
  return { service, jobs, records, advance, lobby, room, reveal };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

void test("rooms isolate boards, timers, subscriptions, resets and credentials", (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const a = actor("a"),
    b = actor("b"),
    c = actor("c"),
    d = actor("d");
  const first = f.room(a, b);
  f.advance(3000, [a, b]);
  const second = f.room(c, d);
  let updatesA = 0,
    updatesB = 0;
  f.service.listen(first.roomId, () => updatesA++);
  f.service.listen(second.roomId, () => updatesB++);
  f.reveal(a, first.roomId, 0);
  assert.equal(updatesA, 1);
  assert.equal(updatesB, 0);
  assert.ok(
    f.service.snapshot(second.roomId).cells.every((c) => c.kind === "covered"),
  );
  const s = f.service.snapshot(first.roomId);
  assert.throws(
    () =>
      f.service.reveal(c, {
        roomId: first.roomId,
        matchId: s.matchId,
        turnId: s.turnId,
        cellIndex: 1,
      }),
    /seat/,
  );
  assert.throws(
    () =>
      f.service.reveal(c, {
        roomId: second.roomId,
        matchId: s.matchId,
        turnId: s.turnId,
        cellIndex: 1,
      }),
    /expired/,
  );
  f.advance(7000, [a, b, c, d]);
  assert.notEqual(f.service.snapshot(first.roomId).turnId, s.turnId);
  assert.equal(
    f.service.snapshot(second.roomId).activePlayer,
    f.service.snapshot(second.roomId).players[0]!.id,
  );
  const other = f.service.snapshot(second.roomId);
  f.service.reset(first.roomId);
  assert.deepEqual(f.service.snapshot(second.roomId), other);
});
void test("one account owns one seat across devices and cannot queue or play against itself", (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const a = actor("a", "user-a"),
    otherDevice = actor("device", "user-a"),
    b = actor("b", "user-b");
  const r = f.room(a, b);
  f.lobby(otherDevice);
  assert.equal(
    f.service.create(otherDevice, "Other", "public").roomId,
    r.roomId,
  );
  assert.equal(f.service.queueJoin(otherDevice, "Other").roomId, r.roomId);
  const closeDevice = f.service.connect(otherDevice, r.roomId, () => undefined);
  assert.equal(
    f.service.join(otherDevice, r.roomId, "Other").players.length,
    2,
  );
  r.closeA();
  assert.equal(f.service.snapshot(r.roomId).players[0]!.connected, true);
  f.reveal(otherDevice, r.roomId, 0);
  closeDevice();
  assert.equal(f.service.snapshot(r.roomId).players[0]!.connected, false);
  assert.notEqual(f.service.snapshot(r.roomId).players[0]!.reservedUntil, null);
});
void test("account changes invalidate old browser streams without transferring its seat", (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const a = actor("browser", "user-a"),
    b = actor("b", "user-b"),
    guest = actor("browser");
  const r = f.room(a, b);
  assert.throws(() => f.service.heartbeat(guest), /account changed/);
  f.lobby(guest);
  assert.equal(f.service.lobby(guest).roomId, null);
  assert.throws(() => f.reveal(guest, r.roomId, 0), /seat/);
  assert.equal(f.service.lobby(a).roomId, r.roomId);
});
void test("account pairing takes priority, duplicate queue joins are idempotent, and cancellation works", (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const a = actor("a", "account-a"),
    b = actor("b", "account-b"),
    guest = actor("g");
  for (const p of [a, b, guest]) f.lobby(p);
  f.service.queueJoin(guest, "Guest");
  f.service.queueJoin(a, "Alice");
  f.service.queueJoin(a, "Alice");
  assert.equal(f.service.clients().queued, 2);
  const pair = f.service.queueJoin(b, "Bob");
  assert.ok(pair.roomId);
  assert.equal(f.service.lobby(a).roomId, pair.roomId);
  assert.equal(f.service.lobby(guest).roomId, null);
  assert.equal(f.service.snapshot(pair.roomId).phase, "lobby");
  f.service.connect(a, pair.roomId, () => undefined);
  assert.equal(f.service.snapshot(pair.roomId).phase, "lobby");
  f.service.connect(b, pair.roomId, () => undefined);
  assert.equal(f.service.snapshot(pair.roomId).phase, "active");
  f.service.queueCancel(guest);
  assert.equal(f.service.clients().queued, 0);
});
void test("mixed pairing happens after 30 seconds without a new command and remains unrecorded", (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const a = actor("a", "account-a"),
    g = actor("g");
  f.lobby(a);
  f.lobby(g);
  f.service.queueJoin(a, "Alice");
  f.service.queueJoin(g, "Guest");
  f.advance(ACCOUNT_WAIT_MS - 1, [a, g]);
  assert.equal(f.service.lobby(a).roomId, null);
  f.advance(1, [a, g]);
  const roomId = f.service.lobby(a).roomId!;
  assert.ok(roomId);
  f.service.connect(a, roomId, () => undefined);
  f.service.connect(g, roomId, () => undefined);
  assert.equal(f.service.snapshot(roomId).saveStatus, "unrecorded");
  assert.deepEqual(f.service.lobby(actor("visitor")).rooms, []);
});
void test("expired queue entries and no-show room handoffs are cleaned up", (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const a = actor("a"),
    b = actor("b");
  f.lobby(a);
  f.lobby(b);
  f.service.queueJoin(a, "A");
  f.service.queueJoin(b, "B");
  const roomId = f.service.lobby(a).roomId!;
  f.advance(15_000, [a, b]);
  assert.throws(() => f.service.snapshot(roomId), /closed/);
  assert.equal(f.service.lobby(a).roomId, null);
  f.service.queueJoin(a, "A");
  f.advance(15_000);
  assert.equal(f.service.clients().queued, 0);
});
void test("account replay faithfully records reveals, timeouts and terminal state without private data", async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const a = actor("a", "secret-account-a"),
    b = actor("b", "secret-account-b");
  const { roomId } = f.room(a, b);
  f.reveal(a, roomId, 0);
  f.advance(10000, [a, b]);
  for (let i = 1; i < 11; i++) f.reveal(b, roomId, i);
  await flush();
  assert.equal(f.records.length, 1);
  const record = f.records[0]!;
  assert.equal(record.playerOneId, a.userId);
  assert.equal(record.winnerSeat, 1);
  assert.equal(record.reason, "completed");
  assert.equal(record.replay.frames[0]!.event, "start");
  assert.ok(record.replay.frames.some((frame) => frame.event === "timeout"));
  assert.ok(
    record.replay.frames[0]!.state.cells.every(
      (cell) => cell.kind === "covered",
    ),
  );
  const final = record.replay.frames.at(-1)!;
  assert.equal(final.state.phase, "finished");
  assert.equal(final.state.winner, "1");
  assert.equal(final.state.players[0]!.score, 1);
  assert.equal(final.state.players[1]!.score, 10);
  assert.equal(
    final.state.cells.filter((cell) => cell.kind === "bomb").length,
    11,
  );
  assert.equal(JSON.stringify(record.replay).includes("secret-account"), false);
  assert.equal(JSON.stringify(record.replay).includes('"bombs"'), false);
  assert.deepEqual(
    record.replay.frames.map((frame) => frame.sequence),
    record.replay.frames.map((_, i) => i),
  );
  assert.equal(f.service.snapshot(roomId).saveStatus, "saved");
});
void test("forfeit saves only account games, preserves unrevealed cells, and cannot be recorded twice", async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const a = actor("a", "account-a"),
    b = actor("b", "account-b");
  const r = f.room(a, b);
  f.reveal(a, r.roomId, 0);
  f.service.leave(a, r.roomId);
  f.service.leave(a, r.roomId);
  await flush();
  assert.equal(f.records.length, 1);
  assert.equal(f.records[0]!.reason, "forfeit");
  assert.equal(f.records[0]!.winnerSeat, 1);
  assert.equal(
    f.records[0]!.replay.frames.at(-1)!.state.cells.filter(
      (c) => c.kind === "covered",
    ).length,
    35,
  );
  assert.throws(
    () => f.service.rematch(b, r.roomId, f.service.snapshot(r.roomId).matchId),
    /no longer/,
  );
  f.service.leave(b, r.roomId);
  await flush();
  assert.equal(f.records.length, 1);
  for (const [x, y] of [
    [actor("guest-a"), actor("guest-b")],
    [actor("mixed-a", "account-a"), actor("mixed-b")],
  ] as const) {
    const mixed = f.room(x, y);
    f.service.leave(x, mixed.roomId);
  }
  await flush();
  assert.equal(f.records.length, 1);
});
void test("operator cancellation and both players disconnecting discard replay buffers without a result", async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const a = actor("a", "account-a"),
    b = actor("b", "account-b");
  const r = f.room(a, b);
  f.reveal(a, r.roomId, 0);
  f.service.reset(r.roomId);
  await flush();
  assert.equal(f.records.length, 0);
  f.service.start(r.roomId);
  r.closeA();
  r.closeB();
  f.advance(15000);
  await flush();
  assert.equal(f.records.length, 0);
  assert.equal(f.service.clients().rooms.length, 0);
});
void test("record retries survive room disposal and preserve an immutable match payload", async (t) => {
  const attempts: MatchRecord[] = [];
  let fail = true;
  const f = fixture(async (record) => {
    attempts.push(structuredClone(record));
    record.replay.frames.length = 0;
    if (fail) throw new Error("offline");
  });
  t.after(() => f.service.dispose());
  const a = actor("a", "account-a"),
    b = actor("b", "account-b");
  const r = f.room(a, b);
  f.service.leave(a, r.roomId);
  await flush();
  assert.equal(f.service.snapshot(r.roomId).saveStatus, "failed");
  assert.equal(f.service.clients().failedSaves, 1);
  f.service.leave(b, r.roomId);
  assert.equal(f.service.clients().rooms.length, 0);
  fail = false;
  f.advance(5000);
  await flush();
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(f.service.clients().pendingSaves, 0);
});
void test("each rematch has its own replay and saved result", async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const a = actor("a", "account-a"),
    b = actor("b", "account-b");
  const { roomId } = f.room(a, b);
  for (let i = 0; i < 11; i++) f.reveal(a, roomId, i);
  const old = f.service.snapshot(roomId).matchId;
  f.service.rematch(a, roomId, old);
  f.service.rematch(b, roomId, old);
  f.service.leave(b, roomId);
  await flush();
  assert.equal(f.records.length, 2);
  assert.notEqual(f.records[0]!.matchId, f.records[1]!.matchId);
  assert.equal(f.records[1]!.replay.frames[0]!.elapsedMs, 0);
  assert.ok(
    f.records[1]!.replay.frames[0]!.state.cells.every(
      (cell) => cell.kind === "covered",
    ),
  );
});
void test("visitors and duplicate tabs cannot add replay presence events", async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const a = actor("a", "account-a"),
    b = actor("b", "account-b");
  const { roomId } = f.room(a, b);
  const visitor = f.service.connect(actor("visitor"), roomId, () => undefined);
  visitor();
  const duplicate = f.service.connect(a, roomId, () => undefined);
  duplicate();
  f.service.leave(b, roomId);
  await flush();
  assert.deepEqual(
    f.records[0]!.replay.frames.map((frame) => frame.event),
    ["start", "forfeit"],
  );
});
void test("room streams emit a final closed snapshot and release listeners/presence", async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const a = actor("a");
  f.lobby(a);
  const { roomId } = f.service.create(a, "Alice", "public");
  const subscription = gameStream({
    snapshot: () => f.service.snapshot(roomId, a),
    listen: (fn) => f.service.listen(roomId, fn),
    connect: (close) => f.service.connect(a, roomId, close),
    isTerminal: (s) => s.phase === "closed",
  });
  assert.equal((await subscription.next()).value?.phase, "lobby");
  f.service.leave(a, roomId);
  assert.equal((await subscription.next()).value?.phase, "closed");
  assert.equal((await subscription.next()).done, true);
  assert.equal(f.service.clients().rooms.length, 0);
});

void test("lobby heartbeats cannot keep an abruptly broken room stream alive", (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const a = actor("a"),
    b = actor("b");
  const { roomId } = f.room(a, b);
  f.lobby(a);
  for (let i = 0; i < 6; i++) {
    f.advance(5000);
    f.service.heartbeat(a, null);
    f.service.heartbeat(b, roomId);
  }
  const s = f.service.snapshot(roomId);
  assert.equal(s.phase, "finished");
  assert.equal(s.resultReason, "forfeit");
  assert.equal(s.winner, s.players[1]!.id);
  assert.equal(f.service.clients().count, 2);
  assert.equal(f.service.lobby(a).roomId, null);
});

void test("closing a room reschedules the remaining lobby lease", (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const a = actor("a"),
    b = actor("b");
  const { roomId } = f.room(a, b);
  f.advance(3000);
  f.lobby(a);
  f.service.leave(a, roomId);
  f.advance(15000);
  assert.equal(f.service.clients().count, 0);
});
void test("queue lease expiry publishes the empty queue to operators", (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  const a = actor("a");
  f.lobby(a);
  f.service.queueJoin(a, "Alice");
  let count = 1;
  f.service.listen("operator", () => {
    count = f.service.clients().queued;
  });
  f.advance(15000);
  assert.equal(count, 0);
});
