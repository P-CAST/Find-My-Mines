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
import type {
  ClientsSnapshot,
  GameSnapshot,
  LobbySnapshot,
} from "../src/server/game/service";
import type { BoardSnapshot } from "../src/server/messages/service";
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
        condition: (op) => op.path.startsWith("messages."),
        true: httpLink({ ...options, url: `${origin}/api/messages` }),
        false: splitLink({
          condition: (op) =>
            [
              "game.session",
              "game.setGuestName",
              "game.login",
              "game.logout",
            ].includes(op.path),
          true: httpLink(options),
          false: httpBatchStreamLink(options),
        }),
      }),
    ],
  });
  return { api, transport };
}
async function stream<T>(
  owner: ReturnType<typeof client>,
  path: string,
  input?: unknown,
) {
  const abort = new AbortController();
  const response = await owner.transport(
    `${origin}/api/${path.startsWith("messages.") ? "messages" : "trpc"}/${path}${input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(superjson.serialize(input)))}`}`,
    {
      signal: abort.signal,
    },
  );
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
const players = [client(), client(), client(), client()];
const [a, b, c, d] = players as [
  ReturnType<typeof client>,
  ReturnType<typeof client>,
  ReturnType<typeof client>,
  ReturnType<typeof client>,
];
const op = client();
const closers: (() => Promise<void>)[] = [];
const beats: ReturnType<typeof setInterval>[] = [];
const roomScopes = new Map<ReturnType<typeof client>, string>();
const owned: { owner: ReturnType<typeof client>; roomId: string }[] = [];
try {
  await Promise.all([...players, op].map((c) => c.api.game.session.query()));
  await assert.rejects(
    a.api.game.create.mutate({ visibility: "public" }),
    /homepage/,
  );
  await assert.rejects(a.api.game.createBot.mutate(), /homepage/);
  await assert.rejects(a.api.game.queueJoin.mutate(), /homepage/);
  await assert.rejects(
    a.api.game.join.mutate({ roomId: "00000000-0000-0000-0000-000000000000" }),
    /homepage/,
  );
  await assert.rejects(
    a.api.messages.send.mutate({ text: "Unnamed guest" }),
    /homepage/,
  );
  await Promise.all(
    players.map((player, index) =>
      player.api.game.setGuestName.mutate({
        nickname: ["HTTP Alice", "HTTP Bob", "HTTP Carol", "HTTP Dana"][index]!,
      }),
    ),
  );
  assert.equal((await a.api.game.session.query()).nickname, "HTTP Alice");
  await assert.rejects(
    a.api.game.setGuestName.mutate({ nickname: "Changed name" }),
    /fixed/,
  );
  const dummy = { roomId: "00000000-0000-0000-0000-000000000000" };
  await assert.rejects(a.api.game.reset.mutate(dummy), /Operator login/);
  await assert.rejects(a.api.game.start.mutate(dummy), /Operator login/);
  await op.api.game.login.mutate({ password });
  const dashboard = await stream<ClientsSnapshot>(op, "game.onClients");
  closers.push(dashboard.close);
  const initial = await until(() => dashboard.latest(), "operator snapshot");
  assert.equal(
    initial.rooms.length,
    0,
    "Integration verification requires an empty lobby; it will not change another room.",
  );
  assert.equal(
    initial.queued,
    0,
    "Integration verification requires an empty queue.",
  );
  const baseline = initial.count;
  // Message streams do not establish game presence and use a separate route.
  const aBoard = await stream<BoardSnapshot>(a, "messages.onBoard");
  const bBoard = await stream<BoardSnapshot>(b, "messages.onBoard");
  closers.push(aBoard.close, bBoard.close);
  await until(() => aBoard.latest() && bBoard.latest(), "message snapshots");
  const beforeChat = dashboard.latest()!;
  const sent = await a.api.messages.send.mutate({
    text: "Integration global message",
  });
  await assert.rejects(
    a.api.messages.send.mutate({ text: "Too soon" }),
    /two seconds/,
  );
  await until(
    () => aBoard.latest()?.messages.some((message) => message.id === sent.id),
    "sender message fanout",
  );
  await until(
    () => bBoard.latest()?.messages.some((message) => message.id === sent.id),
    "global message fanout",
  );
  assert.equal(
    aBoard.latest()!.messages.find((message) => message.id === sent.id)!.own,
    true,
  );
  assert.equal(
    bBoard.latest()!.messages.find((message) => message.id === sent.id)!.own,
    false,
  );
  const guestName = aBoard
    .latest()!
    .messages.find((message) => message.id === sent.id)!.nickname;
  assert.equal(guestName, "HTTP Alice");
  assert.equal(
    bBoard.latest()!.messages.find((message) => message.id === sent.id)!
      .nickname,
    guestName,
  );
  const spoofed = await a.transport(`${origin}/api/messages/messages.send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      superjson.serialize({ text: "Forged author", nickname: "Impersonator" }),
    ),
  });
  assert.equal(spoofed.status, 400);
  assert.equal(dashboard.latest()!.count, baseline);
  assert.equal(dashboard.latest()!.revision, beforeChat.revision);
  const wrongGameRoute = await a.transport(
    `${origin}/api/messages/game.session`,
  );
  const wrongMessageRoute = await a.transport(
    `${origin}/api/trpc/messages.onBoard`,
  );
  assert.equal(wrongGameRoute.status, 404);
  assert.equal(wrongMessageRoute.status, 404);
  const crossOrigin = await a.transport(
    `${origin}/api/messages/messages.onBoard`,
    {
      headers: { origin: "https://different-origin.invalid" },
    },
  );
  assert.equal(crossOrigin.status, 403);
  await aBoard.close();
  const reconnectedBoard = await stream<BoardSnapshot>(a, "messages.onBoard");
  closers.push(reconnectedBoard.close);
  await until(
    () =>
      reconnectedBoard
        .latest()
        ?.messages.some((message) => message.id === sent.id),
    "message history on reconnect",
  );
  assert.equal(
    reconnectedBoard
      .latest()!
      .messages.find((message) => message.id === sent.id)!.nickname,
    guestName,
  );
  for (const player of players) {
    const lobby = await stream<LobbySnapshot>(player, "game.onLobby");
    closers.push(lobby.close);
    await until(() => lobby.latest(), "lobby connection");
    beats.push(
      setInterval(() => {
        void player.api.game.heartbeat.mutate({}).catch(() => undefined);
        const roomId = roomScopes.get(player);
        if (roomId)
          void player.api.game.heartbeat
            .mutate({ roomId })
            .catch(() => undefined);
      }, 4000),
    );
  }
  const first = await a.api.game.create.mutate({
    visibility: "public",
  });
  owned.push({ owner: a, roomId: first.roomId });
  const second = await c.api.game.create.mutate({
    visibility: "unlisted",
  });
  owned.push({ owner: c, roomId: second.roomId });
  const roomBoard = await stream<BoardSnapshot>(c, "messages.onBoard");
  closers.push(roomBoard.close);
  await until(
    () =>
      roomBoard.latest()?.messages.some((message) => message.id === sent.id),
    "global history from invite-only room",
  );
  const aState = await stream<GameSnapshot>(a, "game.onState", first);
  closers.push(aState.close);
  let bState = await stream<GameSnapshot>(b, "game.onState", first);
  closers.push(bState.close);
  const cState = await stream<GameSnapshot>(c, "game.onState", second);
  closers.push(cState.close);
  const dState = await stream<GameSnapshot>(d, "game.onState", second);
  closers.push(dState.close);
  await until(
    () =>
      aState.latest() && bState.latest() && cState.latest() && dState.latest(),
    "room snapshots",
  );
  roomScopes.set(a, first.roomId);
  roomScopes.set(b, first.roomId);
  roomScopes.set(c, second.roomId);
  roomScopes.set(d, second.roomId);
  const joined = await b.api.game.join.mutate({
    ...first,
  });
  owned.push({ owner: b, roomId: first.roomId });
  const otherRoom = await d.api.game.join.mutate({
    ...second,
  });
  owned.push({ owner: d, roomId: second.roomId });
  assert.equal(joined.phase, "active");
  assert.equal(otherRoom.phase, "active");
  assert.equal(joined.instanceId, otherRoom.instanceId);
  await until(
    () =>
      aState.latest()?.revision === joined.revision &&
      bState.latest()?.revision === joined.revision,
    "join fanout",
  );
  await until(
    () => dashboard.latest()?.count === baseline + 4,
    "session reference counts",
  );
  const aid = aState.latest()!.viewerId!,
    bid = bState.latest()!.viewerId!;
  const active = joined.activePlayer === aid ? a : b;
  const other = active === a ? b : a;
  const input = {
    ...first,
    matchId: joined.matchId,
    turnId: joined.turnId,
    cellIndex: 0,
  };
  await assert.rejects(other.api.game.reveal.mutate(input), /not your turn/);
  await assert.rejects(c.api.game.reveal.mutate(input), /seat/);
  const reveal = await active.api.game.reveal.mutate(input);
  await until(
    () =>
      aState.latest()?.revision === reveal.revision &&
      bState.latest()?.revision === reveal.revision,
    "reveal fanout",
  );
  assert.ok(cState.latest()!.cells.every((cell) => cell.kind === "covered"));
  const turnId = aState.latest()!.turnId;
  await until(
    () => aState.latest()?.turnId !== turnId,
    "autonomous turn timer",
    12000,
  );
  await bState.close();
  await until(
    () =>
      aState.latest()?.players.find((p) => p.id === bid)?.connected === false,
    "room close despite lobby and messaging streams",
  );
  bState = await stream<GameSnapshot>(b, "game.onState", first);
  closers.push(bState.close);
  await until(
    () => bState.latest()?.players.find((p) => p.id === bid)?.connected,
    "reconnect",
  );
  assert.equal(bState.latest()!.matchId, joined.matchId);
  const duplicate = await stream<GameSnapshot>(a, "game.onState", first);
  closers.push(duplicate.close);
  await until(() => duplicate.latest(), "duplicate tab");
  assert.equal(dashboard.latest()!.count, baseline + 4);
  await duplicate.close();
  const reset = await op.api.game.reset.mutate(first);
  assert.equal(reset.phase, "lobby");
  assert.equal(reset.players.length, 2);
  assert.equal(cState.latest()!.matchId, otherRoom.matchId);
  const started = await op.api.game.start.mutate(first);
  assert.equal(started.phase, "active");
  clearInterval(beats[1]);
  await until(
    () =>
      aState.latest()?.players.find((p) => p.id === bid)?.connected === false,
    "lease expiry despite active messaging SSE",
    18000,
  );
  await until(
    () => aState.latest()?.resultReason === "forfeit",
    "forfeit after grace",
    18000,
  );
  assert.equal(aState.latest()!.winner, aid);
  assert.equal(aState.latest()!.saveStatus, "unrecorded");
  await op.api.game.logout.mutate();
  await assert.rejects(op.api.game.reset.mutate(first), /Operator login/);
  console.log(
    "PASS: isolated messaging HTTP/SSE, global fanout/history, posting limits, two isolated rooms, server timers, duplicate tabs, reconnect, operator controls, and guest forfeit despite messaging connections.",
  );
} finally {
  beats.forEach(clearInterval);
  for (const { owner, roomId } of owned)
    await owner.api.game.leave.mutate({ roomId }).catch(() => undefined);
  for (const owner of players)
    await owner.api.game.queueCancel.mutate().catch(() => undefined);
  await Promise.all(closers.map((close) => close()));
}
