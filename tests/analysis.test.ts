import assert from "node:assert/strict";
import { test } from "node:test";
import { TRPCError } from "@trpc/server";
import {
  buildEvidence,
  createAnalysisCoordinator,
  createAnalysisService,
  requestReport,
  type AnalysisReport,
  type AnalysisSource,
  type SavedAnalysis,
} from "../src/server/game/analysis";
import type { ReplayFrame } from "../src/server/game/service";

function source(): AnalysisSource {
  const state: ReplayFrame["state"] = {
    cells: Array.from({ length: 36 }, () => ({ kind: "covered" })),
    players: [0, 1].map((i) => ({
      id: String(i),
      nickname: "SECRET_NAME",
      score: 0,
      account: true,
      seated: true,
      connected: true,
      reservedUntil: null,
    })),
    activePlayer: "0",
    deadline: 10000,
    winner: null,
    phase: "active",
    resultReason: null,
  };
  const frames: ReplayFrame[] = [];
  const push = (
    event: ReplayFrame["event"],
    elapsedMs: number,
    cellIndex?: number,
  ) =>
    frames.push({
      sequence: frames.length,
      event,
      elapsedMs,
      ...(cellIndex === undefined ? {} : { cellIndex }),
      state: structuredClone(state),
    });
  push("start", 0);
  state.cells[0] = { kind: "bomb" };
  state.players[0]!.score++;
  push("reveal", 1000, 0);
  state.players[0]!.connected = false;
  push("presence", 1200);
  state.cells[1] = { kind: "bomb" };
  state.players[0]!.score++;
  push("reveal", 2000, 1);
  state.cells[2] = { kind: "empty", adjacent: 2 };
  state.activePlayer = "1";
  state.deadline = 13000;
  push("reveal", 3000, 2);
  state.activePlayer = "0";
  state.deadline = 23000;
  push("timeout", 13000);
  state.cells[3] = { kind: "bomb" };
  state.players[0]!.score++;
  state.activePlayer = null;
  state.deadline = null;
  state.winner = "0";
  state.phase = "finished";
  state.resultReason = "completed";
  push("reveal", 14000, 3);
  return { replay: { version: 1, frames }, winnerSeat: 0, reason: "completed" };
}
const report: AnalysisReport = {
  summary: "Player 1 scored during two turns.",
  keyMoments: [
    { sequence: 4, explanation: "An empty cell passed play to Player 2." },
  ],
  coaching: [
    { seat: 0, tips: ["Keep track of the remaining turn time."] },
    { seat: 1, tips: ["Watch the timer."] },
  ],
};
const generated = () => ({
  document: { report, statistics: buildEvidence(source()).statistics },
  inputTokens: 100,
  outputTokens: 50,
});
const config = { apiKey: "test-secret", model: "test-model" };
const envelope = (value: unknown = report) => ({
  status: "completed",
  output: [
    {
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify(value) }],
    },
  ],
  usage: { input_tokens: 100, output_tokens: 50 },
});
const transport =
  (value: unknown, status = 200): typeof fetch =>
  async () =>
    new Response(JSON.stringify(value), { status });

void test("evidence attributes outcomes to the preceding active seat and excludes identities", () => {
  const evidence = buildEvidence(source());
  assert.deepEqual(evidence.statistics.players[0], {
    seat: 0,
    score: 3,
    bombs: 3,
    emptyCells: 1,
    timeouts: 0,
    longestScoringRun: 2,
  });
  assert.equal(evidence.statistics.players[1]!.timeouts, 1);
  assert.equal(evidence.statistics.turnChanges, 2);
  assert.equal(evidence.events[4]!.actor, 0);
  assert.equal(evidence.events[5]!.actor, 1);
  assert.equal(evidence.events[6]!.actor, 0);
  assert.equal(evidence.events[4]!.boardBefore?.[2]?.kind, "covered");
  assert.equal(evidence.events[4]!.revealed?.kind, "empty");
  assert.equal(evidence.events[3]!.remainingMsBefore, 8000);
  assert.equal(evidence.events[6]!.remainingMsBefore, 9000);
  assert.ok(!JSON.stringify(evidence).includes("SECRET_NAME"));
  assert.ok(!JSON.stringify(evidence).includes("nickname"));
  const forfeited = source();
  forfeited.reason = "forfeit";
  const last = forfeited.replay.frames.at(-1)!;
  last.event = "forfeit";
  delete last.cellIndex;
  assert.equal(buildEvidence(forfeited).statistics.players[0]!.bombs, 2);
  assert.throws(
    () => buildEvidence({ ...source(), replay: { version: 1, frames: [] } }),
    /cannot be analyzed/,
  );
  const large = source();
  const frame = structuredClone(large.replay.frames.at(-1)!);
  for (let i = 0; i < 1000; i++)
    large.replay.frames.push({
      ...frame,
      sequence: large.replay.frames.length,
    });
  assert.throws(() => buildEvidence(large), /too large/);
});
void test("provider uses structured stateless requests and validates reports", async () => {
  const mock: typeof fetch = async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    assert.ok(options?.signal);
    assert.equal(typeof options?.body, "string");
    const body = JSON.parse(options?.body as string) as {
      store: boolean;
      max_output_tokens: number;
      input: string;
      text: { format: { strict: boolean } };
    };
    assert.equal(body.store, false);
    assert.equal(body.max_output_tokens, 8000);
    assert.equal(body.text.format.strict, true);
    assert.ok(!body.input.includes("SECRET_NAME"));
    assert.ok(!body.input.includes("test-secret"));
    return new Response(JSON.stringify(envelope()));
  };
  assert.deepEqual(
    (await requestReport(buildEvidence(source()), config, mock)).document
      .report,
    report,
  );
  for (const invalid of [
    {
      ...report,
      keyMoments: [{ sequence: 100, explanation: "Unknown event" }],
    },
    { ...report, coaching: [report.coaching[0], report.coaching[0]] },
    { ...report, summary: "x".repeat(1201) },
  ])
    await assert.rejects(
      requestReport(
        buildEvidence(source()),
        config,
        transport(envelope(invalid)),
      ),
      /valid report/,
    );
  await assert.rejects(
    requestReport(
      buildEvidence(source()),
      config,
      transport({ ...envelope(), status: "incomplete" }),
    ),
    /valid report/,
  );
  await assert.rejects(
    requestReport(
      buildEvidence(source()),
      config,
      transport({
        ...envelope(),
        output: [{ type: "message", content: [{ type: "refusal" }] }],
      }),
    ),
    /valid report/,
  );
  for (const status of [401, 429, 500])
    await assert.rejects(
      requestReport(
        buildEvidence(source()),
        config,
        transport({ error: "secret upstream details" }, status),
      ),
      /temporarily unavailable/,
    );
  const timeout: typeof fetch = async (_url, options) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    options?.signal?.throwIfAborted();
    throw new Error("should abort");
  };
  await assert.rejects(
    requestReport(buildEvidence(source()), config, timeout, 1),
    /timed out/,
  );
});

function storeFixture() {
  const saved = new Map<string, SavedAnalysis>();
  let isPublic = false;
  const store = {
    async analysisSource(
      viewerId: string | null,
      _matchId: string,
      participantOnly = false,
    ) {
      const isParticipant = viewerId === "a" || viewerId === "b";
      if (!isParticipant && (participantOnly || !isPublic))
        throw new TRPCError({ code: "NOT_FOUND" });
      return { ...source(), isParticipant };
    },
    async readAnalysis(viewerId: string | null, matchId: string) {
      await store.analysisSource(viewerId, matchId);
      return saved.get(matchId) ?? null;
    },
    async saveAnalysis(value: SavedAnalysis) {
      saved.set(value.matchId, value);
      return value;
    },
  };
  return {
    store,
    setPublic(value: boolean) {
      isPublic = value;
    },
  };
}
void test("generation checks access, deduplicates participants and reuses persistent reports without a key", async () => {
  const fixture = storeFixture();
  const coordinator = createAnalysisCoordinator();
  let calls = 0;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = createAnalysisService(
    fixture.store,
    config,
    coordinator,
    async () => {
      calls++;
      await hold;
      return generated();
    },
  );
  await assert.rejects(service.generate("outsider", "match"));
  fixture.setPublic(true);
  assert.equal((await service.read(null, "match")).canGenerate, false);
  await assert.rejects(service.generate("outsider", "match"));
  const a = service.generate("a", "match");
  const b = service.generate("b", "match");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await a, await b);
  assert.equal(coordinator.pending.size, 0);
  const disabled = createAnalysisService(fixture.store, {}, coordinator);
  assert.ok((await disabled.read(null, "match")).saved);
  assert.ok(await disabled.generate("a", "match"));
  await assert.rejects(disabled.generate("a", "another"), /not configured/);
  fixture.setPublic(false);
  await assert.rejects(service.read(null, "match"));
  assert.ok((await service.read("b", "match")).saved);
  assert.equal(calls, 1);
});
void test("failed requests release slots and enforce five attempts per hour", async () => {
  const fixture = storeFixture();
  const coordinator = createAnalysisCoordinator();
  let now = 0;
  const service = createAnalysisService(
    fixture.store,
    config,
    coordinator,
    async () => {
      throw new TRPCError({ code: "BAD_GATEWAY", message: "provider failure" });
    },
    () => now,
  );
  for (let i = 0; i < 5; i++) {
    await assert.rejects(service.generate("a", "match"), /provider failure/);
    assert.equal(coordinator.pending.size, 0);
  }
  await assert.rejects(service.generate("a", "match"), /limit reached/);
  now = 3_600_000;
  await assert.rejects(service.generate("a", "match"), /provider failure/);
});
void test("global concurrency rejects a third distinct request and recovers", async () => {
  const fixture = storeFixture();
  const coordinator = createAnalysisCoordinator();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = createAnalysisService(
    fixture.store,
    config,
    coordinator,
    async () => {
      await hold;
      return generated();
    },
  );
  const a = service.generate("a", "one"),
    b = service.generate("b", "two");
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(service.generate("a", "three"), /limit reached/);
  release();
  await Promise.all([a, b]);
  assert.ok(await service.generate("a", "three"));
});
