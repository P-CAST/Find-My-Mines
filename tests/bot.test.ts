import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildBotInput,
  createBotProvider,
  type BotProvider,
} from "../src/server/game/bot";
import {
  GameService,
  type Actor,
  type ServiceOptions,
} from "../src/server/game/service";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const human: Actor = { sessionId: "human", userId: null };
function fixture(
  provider: BotProvider = async () => 0,
  options: ServiceOptions = {},
) {
  let now = 1000,
    serial = 0;
  const jobs = new Map<number, { at: number; run: () => void }>();
  let saves = 0;
  const signals: AbortSignal[] = [];
  let calls = 0;
  const service = new GameService({
    now: () => now,
    schedule: (run, ms) => {
      const id = ++serial;
      jobs.set(id, { at: now + ms, run });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (id) => {
      jobs.delete(id as unknown as number);
    },
    board: () => new Set(Array.from({ length: 11 }, (_, i) => i)),
    firstPlayer: () => 1,
    randomIndex: () => 0,
    log: () => undefined,
    saveResult: async () => {
      saves++;
    },
    botProvider: async (evidence, signal) => {
      calls++;
      signals.push(signal);
      return provider(evidence, signal);
    },
    ...options,
  });
  const advance = async (ms: number) => {
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
  };
  service.connect(human, null, () => undefined);
  const create = (actor = human) => {
    const { roomId } = service.createBot(actor, "Human");
    const disconnect = service.connect(actor, roomId, () => undefined);
    return { roomId, disconnect };
  };
  return {
    service,
    advance,
    create,
    signals,
    jobs,
    jump: (ms: number) => {
      now += ms;
    },
    calls: () => calls,
    saves: () => saves,
  };
}

void test("bot scoring chains preserve deadline; presence updates do not duplicate decisions; rematches use quota", async (t) => {
  let secondMove!: (index: number) => void;
  const f = fixture(async (evidence) => {
    const index = evidence.cells.findIndex((cell) => cell.kind === "covered");
    return index === 1
      ? new Promise<number>((resolve) => {
          secondMove = resolve;
        })
      : index;
  });
  t.after(() => f.service.dispose());
  const { roomId } = f.create();
  const initial = f.service.snapshot(roomId, human);
  assert.equal(initial.mode, "bot");
  assert.equal(initial.visibility, "unlisted");
  assert.equal(initial.players[1]!.bot, true);
  assert.equal(f.service.clients().count, 1);
  assert.equal(f.service.lobby(human).rooms.length, 0);
  assert.deepEqual(f.service.createBot(human, "Again"), { roomId });
  assert.equal(f.service.lobby(human).bot.remaining, 2);
  const spectator = { sessionId: "watcher", userId: null };
  f.service.connect(spectator, roomId, () => undefined);
  assert.throws(
    () => f.service.join(spectator, roomId, "Watcher"),
    /Game full/,
  );
  await f.advance(0);
  const after = f.service.snapshot(roomId);
  assert.equal(after.players[1]!.score, 1);
  assert.equal(after.deadline, initial.deadline);
  assert.equal(after.turnId, initial.turnId);
  assert.equal(f.calls(), 2);
  assert.throws(
    () =>
      f.service.reveal(spectator, {
        roomId,
        matchId: after.matchId,
        turnId: after.turnId,
        cellIndex: 1,
      }),
    /does not own/,
  );
  assert.throws(
    () =>
      f.service.reveal(human, {
        roomId,
        matchId: after.matchId,
        turnId: after.turnId,
        cellIndex: 1,
      }),
    /not your turn/,
  );
  secondMove(1);
  await flush();
  await f.advance(0);
  const finished = f.service.snapshot(roomId);
  assert.equal(finished.phase, "finished");
  assert.equal(finished.saveStatus, "unrecorded");
  assert.equal(f.saves(), 0);
  assert.equal(f.calls(), 11);
  const rematch = f.service.rematch(human, roomId, finished.matchId);
  assert.equal(rematch.phase, "active");
  assert.notEqual(rematch.matchId, finished.matchId);
  assert.equal(rematch.activePlayer, finished.winner);
  assert.equal(f.service.lobby(human).bot.remaining, 1);
  assert.throws(() => f.service.rematch(human, roomId, finished.matchId));
  assert.equal(f.service.lobby(human).bot.remaining, 1);
});

void test("quota is global, rolling, and counts abandoned games for guests and accounts", async (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  for (let i = 0; i < 3; i++) {
    const actor = { sessionId: String(i), userId: i === 1 ? "account" : null };
    f.service.connect(actor, null, () => undefined);
    const { roomId } = f.create(actor);
    f.service.leave(actor, roomId);
    assert.throws(() => f.service.snapshot(roomId), /closed/);
  }
  assert.equal(f.service.lobby(human).bot.remaining, 0);
  assert.equal(f.service.lobby(human).bot.nextAvailableAt, 3_601_000);
  assert.throws(() => f.service.createBot(human, "Human"), /shared limit/);
  await f.advance(3_599_999);
  assert.equal(f.service.lobby(human).bot.remaining, 0);
  await f.advance(1);
  assert.equal(f.service.lobby(human).bot.remaining, 3);
  f.service.connect(human, null, () => undefined);
  assert.ok(f.create().roomId);
});

void test("bot gets the entire turn; deadline passes play without fallback and ignores late completion", async (t) => {
  let resolve!: (index: number) => void;
  const f = fixture(
    () =>
      new Promise<number>((done) => {
        resolve = done;
      }),
  );
  t.after(() => f.service.dispose());
  const { roomId } = f.create();
  await f.advance(0);
  const initial = f.service.snapshot(roomId, human);
  await f.advance(9999);
  assert.equal(f.signals[0]!.aborted, false);
  assert.equal(f.service.snapshot(roomId).turnId, initial.turnId);
  await f.advance(1);
  const expired = f.service.snapshot(roomId, human);
  assert.equal(expired.activePlayer, expired.viewerId);
  assert.equal(expired.players[1]!.score, 0);
  assert.ok(expired.cells.every((cell) => cell.kind === "covered"));
  assert.equal(f.signals[0]!.aborted, true);
  resolve(5);
  await flush();
  assert.deepEqual(f.service.snapshot(roomId, human), expired);
});

void test("slow valid responses are applied before deadline and scoring requests share remaining time", async (t) => {
  const pending: ((index: number) => void)[] = [];
  const budgets: number[] = [];
  const f = fixture((evidence) => {
    budgets.push(evidence.remainingMs);
    return new Promise<number>((resolve) => pending.push(resolve));
  });
  t.after(() => f.service.dispose());
  const { roomId } = f.create();
  await f.advance(0);
  assert.deepEqual(budgets, [10000]);
  const original = f.service.snapshot(roomId);
  await f.advance(4000);
  pending[0]!(0);
  await flush();
  await f.advance(0);
  assert.deepEqual(budgets, [10000, 6000]);
  assert.equal(f.service.snapshot(roomId).deadline, original.deadline);
  assert.equal(f.service.snapshot(roomId).turnId, original.turnId);
  await f.advance(5999);
  pending[1]!(1);
  await flush();
  assert.equal(f.service.snapshot(roomId).players[1]!.score, 2);
  await f.advance(1);
  assert.equal(
    f.service.snapshot(roomId, human).activePlayer,
    f.service.snapshot(roomId, human).viewerId,
  );
  assert.equal(f.signals.at(-1)!.aborted, true);
});

void test("empty bot moves pass the turn and human timeouts start autonomous bot play", async (t) => {
  let calls = 0;
  let secondMove!: (index: number) => void;
  const f = fixture(() => {
    calls++;
    if (calls === 1) return Promise.resolve(35);
    if (calls === 2)
      return new Promise<number>((resolve) => {
        secondMove = resolve;
      });
    return new Promise<number>(() => undefined);
  });
  t.after(() => f.service.dispose());
  const { roomId } = f.create();
  await f.advance(0);
  const state = f.service.snapshot(roomId, human);
  assert.equal(state.activePlayer, state.viewerId);
  assert.equal(state.cells[35]!.kind, "empty");
  await f.advance(10000);
  assert.equal(f.service.snapshot(roomId).activePlayer, state.players[1]!.id);
  secondMove(35);
  await flush();
  assert.match(f.service.snapshot(roomId).message, /fallback/); // Previously revealed index.
});

void test("disconnect cancels requests; reconnect does not repeat the same decision", async (t) => {
  const f = fixture(() => new Promise<number>(() => undefined));
  t.after(() => f.service.dispose());
  const { roomId, disconnect } = f.create();
  await f.advance(0);
  disconnect();
  assert.equal(f.signals[0]!.aborted, true);
  await f.advance(0);
  assert.equal(f.calls(), 1);
  f.service.connect(human, roomId, () => undefined);
  await f.advance(0);
  assert.equal(f.calls(), 2); // Same decision falls back; only the new board calls OpenAI again.
  assert.equal(f.service.snapshot(roomId).players[1]!.score, 1);
});

void test("reset cancels stale work, manual start consumes a slot, and disposal clears timers", async () => {
  let resolve!: (index: number) => void;
  const f = fixture(
    () =>
      new Promise<number>((done) => {
        resolve = done;
      }),
  );
  const { roomId } = f.create();
  await f.advance(0);
  const reset = f.service.reset(roomId);
  assert.equal(reset.phase, "lobby");
  assert.equal(f.signals[0]!.aborted, true);
  resolve(0);
  await flush();
  assert.equal(f.service.snapshot(roomId).cells[0]!.kind, "covered");
  f.service.start(roomId);
  assert.equal(f.service.lobby(human).bot.remaining, 1);
  await f.advance(0);
  f.service.dispose();
  assert.equal(f.signals.at(-1)!.aborted, true);
  assert.equal(f.jobs.size, 0);
});

void test("human lease expiry and grace close bot rooms without saving", async (t) => {
  const f = fixture(() => new Promise<number>(() => undefined));
  t.after(() => f.service.dispose());
  const { roomId } = f.create();
  await f.advance(30000);
  assert.throws(() => f.service.snapshot(roomId), /closed/);
  assert.equal(f.saves(), 0);
  assert.equal(f.service.clients().rooms.length, 0);
});

void test("missing configuration, queue membership and human rooms reject bot creation without quota use", (t) => {
  const f = fixture();
  t.after(() => f.service.dispose());
  f.service.setBotProvider(undefined);
  assert.throws(() => f.service.createBot(human, "Human"), /not configured/);
  assert.equal(f.service.lobby(human).bot.remaining, 3);
  f.service.setBotProvider(async () => 0);
  f.service.queueJoin(human, "Human");
  assert.throws(
    () => f.service.createBot(human, "Human"),
    /Cancel matchmaking/,
  );
  f.service.queueCancel(human);
  f.service.create(human, "Human", "public");
  assert.throws(
    () => f.service.createBot(human, "Human"),
    /Leave your current room/,
  );
  assert.equal(f.service.lobby(human).bot.remaining, 3);
});

const evidence = {
  cells: Array.from({ length: 36 }, () => ({ kind: "covered" as const })),
  scores: { self: 0, opponent: 0 },
  remainingMs: 9000,
};
const envelope = (text: string) => ({
  status: "completed",
  output: [{ type: "message", content: [{ type: "output_text", text }] }],
  usage: { input_tokens: 10, output_tokens: 5 },
});
void test("provider uses strict structured output and allowlists public data", async () => {
  let body: Record<string, unknown> = {};
  const signal = new AbortController().signal;
  const provider = createBotProvider(
    { apiKey: "secret", model: "test-model" },
    async (_url, init) => {
      assert.equal(init?.signal, signal);
      assert.equal(typeof init?.body, "string");
      body = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(JSON.stringify(envelope('{"cellIndex":7}')));
    },
    () => undefined,
  )!;
  assert.equal(
    await provider(
      {
        ...evidence,
        cells: evidence.cells.map((cell) => ({
          ...cell,
          hiddenBomb: "PRIVATE",
        })),
        scores: { ...evidence.scores, ...{ userId: "PRIVATE" } },
        ...{ bombs: [7], nickname: "PRIVATE", sessionId: "PRIVATE" },
      },
      signal,
    ),
    7,
  );
  assert.deepEqual(JSON.parse(body.input as string), buildBotInput(evidence));
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, 1024);
  assert.equal(body.model, "test-model");
  assert.deepEqual(body.reasoning, { effort: "none" });
  assert.deepEqual(body.text, {
    format: {
      type: "json_schema",
      name: "bot_move",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { cellIndex: { type: "integer", minimum: 0, maximum: 35 } },
        required: ["cellIndex"],
      },
    },
  });
  assert.doesNotMatch(
    JSON.stringify(body),
    /PRIVATE|sessionId|nickname|"bombs"|"secret"/,
  );
  assert.equal(createBotProvider({ apiKey: "secret" }), undefined);
});

void test("provider rejects failures, refusals, incomplete and malformed output", async () => {
  const responses = [
    new Response("", { status: 429 }),
    new Response(JSON.stringify({ ...envelope("{}"), status: "incomplete" })),
    new Response(
      JSON.stringify({
        ...envelope("{}"),
        output: [{ type: "message", content: [{ type: "refusal" }] }],
      }),
    ),
    new Response(JSON.stringify(envelope('{"cellIndex":36}'))),
    new Response(JSON.stringify(envelope('{"cellIndex":1,"reason":"extra"}'))),
    new Response(JSON.stringify(envelope("not json"))),
  ];
  for (const response of responses) {
    const provider = createBotProvider(
      { apiKey: "secret", model: "test-model" },
      async () => response,
      () => undefined,
    )!;
    await assert.rejects(provider(evidence, new AbortController().signal));
  }
});

void test("late response processes an overdue turn before committing a move", async (t) => {
  let resolve!: (index: number) => void;
  const f = fixture(
    () =>
      new Promise<number>((done) => {
        resolve = done;
      }),
  );
  t.after(() => f.service.dispose());
  const { roomId } = f.create();
  await f.advance(0);
  const old = f.service.snapshot(roomId, human);
  f.jump(10000); // Simulate an event-loop delay before the timeout callback executes.
  resolve(0);
  await flush();
  const state = f.service.snapshot(roomId, human);
  assert.notEqual(state.turnId, old.turnId);
  assert.equal(state.activePlayer, state.viewerId);
  assert.equal(state.cells[0]!.kind, "covered");
});

void test("an exhausted rematch quota leaves the completed result untouched", async (t) => {
  const f = fixture(async (e) =>
    e.cells.findIndex((cell) => cell.kind === "covered"),
  );
  t.after(() => f.service.dispose());
  const { roomId } = f.create();
  for (let i = 0; i < 2; i++) {
    const other = { sessionId: `other-${i}`, userId: null };
    f.service.connect(other, null, () => undefined);
    const extra = f.create(other);
    f.service.leave(other, extra.roomId);
  }
  await f.advance(0);
  const result = f.service.snapshot(roomId);
  assert.equal(result.phase, "finished");
  assert.throws(
    () => f.service.rematch(human, roomId, result.matchId),
    /shared limit/,
  );
  assert.deepEqual(f.service.snapshot(roomId), result);
});

void test("provider failure falls back without changing another room", async (t) => {
  const f = fixture(
    async () => {
      throw new Error("provider_failure");
    },
    { randomIndex: (length) => length - 1 },
  );
  t.after(() => f.service.dispose());
  const { roomId } = f.create();
  const other = { sessionId: "other", userId: null };
  f.service.connect(other, null, () => undefined);
  const otherRoom = f.service.create(other, "Other", "public").roomId;
  f.service.connect(other, otherRoom, () => undefined);
  const before = f.service.snapshot(otherRoom);
  await f.advance(0);
  assert.equal(f.service.snapshot(roomId).cells[35]!.kind, "empty");
  assert.match(f.service.snapshot(roomId).message, /fallback/);
  assert.deepEqual(f.service.snapshot(otherRoom).cells, before.cells);
  assert.equal(f.service.snapshot(otherRoom).revision, before.revision);
});

void test("bot input labels the public grid and lists exact corner, edge and center neighbors", () => {
  const input = buildBotInput({
    ...evidence,
    cells: evidence.cells.map((cell, index) => {
      if (index === 0 || index === 5 || index === 7 || index === 35)
        return { kind: "empty", adjacent: index === 0 ? 0 : 2 };
      if (index === 1) return { kind: "bomb" };
      return cell;
    }),
  });
  assert.equal(
    input.grid,
    "  1 2 3 4 5 6\nA 0 B ? ? ? 2\nB ? 2 ? ? ? ?\nC ? ? ? ? ? ?\nD ? ? ? ? ? ?\nE ? ? ? ? ? ?\nF ? ? ? ? ? 2",
  );
  assert.equal(input.cells[0]!.coordinate, "A1");
  assert.equal(input.cells[6]!.coordinate, "B1");
  assert.equal(input.cells[35]!.coordinate, "F6");
  const neighbors = (index: number) =>
    input.clues.find((clue) => clue.index === index)!.neighbors;
  assert.deepEqual(
    neighbors(0).map((cell) => cell.index),
    [1, 6, 7],
  );
  assert.deepEqual(
    neighbors(5).map((cell) => cell.index),
    [4, 10, 11],
  );
  assert.deepEqual(
    neighbors(7).map((cell) => cell.index),
    [0, 1, 2, 6, 8, 12, 13, 14],
  );
  assert.deepEqual(
    neighbors(35).map((cell) => cell.index),
    [28, 29, 34],
  );
  assert.deepEqual(neighbors(0)[0], {
    index: 1,
    coordinate: "A2",
    kind: "bomb",
  });
  assert.deepEqual(neighbors(7)[0], {
    index: 0,
    coordinate: "A1",
    kind: "empty",
    adjacent: 0,
  });
  assert.deepEqual(
    input.legalCellIndices,
    Array.from({ length: 36 }, (_, index) => index).filter(
      (index) => ![0, 1, 5, 7, 35].includes(index),
    ),
  );
});
