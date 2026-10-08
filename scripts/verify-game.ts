/** Runs against an existing, empty classroom server. Never starts/stops a server. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createTRPCClient,
  httpBatchStreamLink,
  httpLink,
  splitLink,
} from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "../src/server/api/root";
import type { ClientsSnapshot, GameSnapshot } from "../src/server/game/service";
import { SERVER_ORIGIN } from "../src/lib/game-config";

const origin = process.env.GAME_TEST_ORIGIN ?? SERVER_ORIGIN;
const password =
  process.env.GAME_OPERATOR_PASSWORD ??
  /^GAME_OPERATOR_PASSWORD=["']?([^\r\n"']+)/m.exec(
    readFileSync(".env", "utf8"),
  )?.[1];
assert.ok(
  password,
  "Set GAME_OPERATOR_PASSWORD before running integration verification.",
);
function client() {
  const cookies = new Map<string, string>();
  const transport: typeof fetch = async (url, options) => {
    const headers = new Headers(options?.headers);
    headers.set(
      "cookie",
      [...cookies].map(([key, value]) => `${key}=${value}`).join("; "),
    );
    const response = await fetch(url, { ...options, headers });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!;
      const split = pair.indexOf("=");
      cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    return response;
  };
  const options = {
    url: `${origin}/api/trpc`,
    transformer: superjson,
    fetch: transport,
  };
  const api = createTRPCClient<AppRouter>({
    links: [
      splitLink({
        condition: (op) =>
          ["game.session", "game.login", "game.logout"].includes(op.path),
        true: httpLink(options),
        false: httpBatchStreamLink(options),
      }),
    ],
  });
  return { api, transport };
}
async function stream<T>(owner: ReturnType<typeof client>, path: string) {
  const abort = new AbortController();
  const response = await owner.transport(`${origin}/api/trpc/${path}`, {
    signal: abort.signal,
  });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  assert.match(response.headers.get("cache-control")!, /no-transform/);
  const reader = response.body!.getReader();
  const snapshots: T[] = [];
  let failure: unknown;
  const done = (async () => {
    const decoder = new TextDecoder();
    let pending = "";
    while (!abort.signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n\n")) !== -1) {
        const chunk = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const data = chunk
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice(6);
        if (
          !data ||
          chunk.includes("event: connected") ||
          chunk.includes("event: ping")
        )
          continue;
        if (chunk.includes("event: serialized-error"))
          throw new Error(`Subscription rejected: ${data}`);
        snapshots.push(
          superjson.deserialize<T>(
            JSON.parse(data) as Parameters<typeof superjson.deserialize>[0],
          ),
        );
      }
    }
  })().catch((error: unknown) => {
    if (!abort.signal.aborted) failure = error;
  });
  return {
    snapshots,
    close: async () => {
      abort.abort();
      await done;
    },
    latest: () => {
      if (failure)
        throw failure instanceof Error
          ? failure
          : new Error("SSE stream failed", { cause: failure });
      return snapshots.at(-1);
    },
  };
}
async function until<T>(
  get: () => T | undefined | false,
  label: string,
  ms = 15000,
): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const result = get();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
}
const a = client();
const b = client();
const visitor = client();
const op = client();
const closers: (() => Promise<void>)[] = [];
const beats: ReturnType<typeof setInterval>[] = [];
let ownsMatch = false;
try {
  const [sa, sb] = await Promise.all([
    a.api.game.session.query(),
    b.api.game.session.query(),
    visitor.api.game.session.query(),
    op.api.game.session.query(),
  ]);
  assert.notEqual(sa.id, sb.id);
  await assert.rejects(a.api.game.reset.mutate(), /Operator login/);
  await assert.rejects(a.api.game.start.mutate(), /Operator login/);
  await op.api.game.login.mutate({ password });
  assert.equal((await op.api.game.session.query()).operator, true);
  const dashboard = await stream<ClientsSnapshot>(op, "game.onClients");
  closers.push(dashboard.close);
  const initial = await until(() => dashboard.latest(), "operator snapshot");
  assert.equal(
    initial.game.players.length,
    0,
    "Integration verification requires an empty lobby; it will not reset another match.",
  );
  const baseline = initial.count;
  const aState = await stream<GameSnapshot>(a, "game.onState");
  closers.push(aState.close);
  let bState = await stream<GameSnapshot>(b, "game.onState");
  closers.push(bState.close);
  const visitorState = await stream<GameSnapshot>(visitor, "game.onState");
  closers.push(visitorState.close);
  for (const c of [a, b, visitor])
    beats.push(
      setInterval(() => {
        void c.api.game.heartbeat.mutate().catch(() => undefined);
      }, 4000),
    );
  await until(
    () => aState.latest() && bState.latest() && visitorState.latest(),
    "three initial snapshots",
  );
  await until(
    () => dashboard.latest()?.count === baseline + 3,
    "unique client count excludes operator stream",
  );
  ownsMatch = true;
  await a.api.game.join.mutate({ nickname: "HTTP Alice" });
  let joined = await b.api.game.join.mutate({ nickname: "HTTP Bob" });
  if (joined.manualStart) joined = await op.api.game.start.mutate();
  assert.equal(joined.phase, "active");
  await until(
    () =>
      aState.latest()?.revision === joined.revision &&
      bState.latest()?.revision === joined.revision,
    "both SSE clients observe HTTP joins",
  );
  assert.equal(joined.instanceId, sa.instanceId);
  assert.equal(joined.instanceId, sb.instanceId);
  await assert.rejects(
    visitor.api.game.join.mutate({ nickname: "Third" }),
    /Game full/,
  );
  const active = joined.activePlayer === sa.id ? a : b;
  const other = active === a ? b : a;
  const input = {
    matchId: joined.matchId,
    turnId: joined.turnId,
    cellIndex: 0,
  };
  await assert.rejects(other.api.game.reveal.mutate(input), /not your turn/);
  const revealed = await active.api.game.reveal.mutate(input);
  await until(
    () =>
      aState.latest()?.revision === revealed.revision &&
      bState.latest()?.revision === revealed.revision,
    "HTTP reveal fans out to both SSE clients",
  );
  await assert.rejects(active.api.game.reveal.mutate(input));
  const beforeTimeout = aState.latest()!;
  const timedOut = await until(
    () => {
      const s = aState.latest();
      return s && s.turnId !== beforeTimeout.turnId && s;
    },
    "server timer with no action requests",
    12000,
  );
  assert.notEqual(timedOut.activePlayer, beforeTimeout.activePlayer);
  console.log(
    "PASS: HTTP mutations and both SSE streams share one authority; timer advances without action requests.",
  );
  await bState.close();
  await until(
    () =>
      aState.latest()?.players.find((p) => p.id === sb.id)?.connected === false,
    "normal close presence cleanup",
  );
  bState = await stream<GameSnapshot>(b, "game.onState");
  closers.push(bState.close);
  const reconnected = await until(
    () => bState.latest(),
    "fresh reconnect snapshot",
  );
  assert.equal(reconnected.matchId, joined.matchId);
  assert.ok(reconnected.revision >= timedOut.revision);
  const duplicateTab = await stream<GameSnapshot>(a, "game.onState");
  closers.push(duplicateTab.close);
  await until(() => duplicateTab.latest(), "second tab initial snapshot");
  assert.equal(dashboard.latest()!.count, baseline + 3);
  await duplicateTab.close();
  const reset = await op.api.game.reset.mutate();
  await until(
    () =>
      aState.latest()?.revision === reset.revision &&
      bState.latest()?.revision === reset.revision,
    "reset fanout",
  );
  assert.equal(reset.phase, "lobby");
  assert.equal(reset.players.length, 2);
  assert.ok(reset.cells.every((c) => c.kind === "covered"));
  await assert.rejects(active.api.game.reveal.mutate(input), /not active/);
  const started = await op.api.game.start.mutate();
  assert.equal(started.phase, "active");
  assert.notEqual(started.matchId, joined.matchId);
  await until(
    () =>
      aState.latest()?.revision === started.revision &&
      bState.latest()?.revision === started.revision,
    "operator start fanout",
  );
  console.log(
    "PASS: reconnection, reference-counted tabs, operator authorization, reset and start.",
  );
  // An open response without client heartbeats must still lose its presence lease.
  clearInterval(beats[1]);
  await until(
    () =>
      aState.latest()?.players.find((p) => p.id === sb.id)?.connected === false,
    "abrupt loss lease expiry",
    18000,
  );
  await until(
    () =>
      aState.latest()?.phase === "lobby" &&
      aState.latest()?.players.length === 1,
    "disconnect grace abort",
    18000,
  );
  const aborted = aState.latest()!;
  assert.equal(aborted.winner, null);
  assert.equal(aborted.deadline, null);
  assert.equal(aborted.players[0]!.score, 0);
  console.log(
    "PASS: missing heartbeats expire presence, reserve the seat, then abort without an artificial win.",
  );
  await op.api.game.logout.mutate();
  assert.equal((await op.api.game.session.query()).operator, false);
  await assert.rejects(op.api.game.reset.mutate(), /Operator login/);
} finally {
  beats.forEach(clearInterval);
  await Promise.all(closers.map((close) => close()));
  // Let the ordinary grace policy release our seats and restore the automatic lobby.
  if (ownsMatch) await new Promise((resolve) => setTimeout(resolve, 16_000));
}
