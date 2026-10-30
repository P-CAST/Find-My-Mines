import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MessageService,
  type MessageActor,
} from "../src/server/messages/service";
import { gameStream } from "../src/server/game/stream";
import { GameService } from "../src/server/game/service";

const guest: MessageActor = {
  sessionId: "private-guest-session",
  userId: null,
};
const other: MessageActor = { sessionId: "other-session", userId: null };
const input = { text: " Hello\nworld " };

void test("messages validate text, preserve plain text, and expose only public fields", () => {
  const service = new MessageService(() => 1234);
  const sent = service.send(guest, {
    ...input,
    text: "<script>alert('hello')</script>\nHello",
  });
  const own = service.snapshot(guest);
  assert.deepEqual(own.messages, [
    {
      id: sent.id,
      nickname: own.messages[0]!.nickname,
      text: "<script>alert('hello')</script>\nHello",
      sentAt: 1234,
      account: false,
      own: true,
    },
  ]);
  assert.match(own.messages[0]!.nickname, /^Anonymous [1-9]\d{5}$/);
  assert.equal(service.snapshot(other).messages[0]!.own, false);
  assert.equal(JSON.stringify(own).includes(guest.sessionId), false);
  for (const invalid of [
    { ...input, text: " \n " },
    { ...input, text: "x".repeat(501) },
    { ...input, text: "bad\u0000text" },
  ])
    assert.throws(() => new MessageService().send(guest, invalid));
  assert.equal(own.revision, 1);
  // Callers cannot mutate retained messages through a returned snapshot.
  own.messages[0]!.text = "changed";
  assert.notEqual(service.snapshot(guest).messages[0]!.text, "changed");
});

void test("author names come from verified account identity or a stable anonymous session label", () => {
  let now = 0;
  const service = new MessageService(() => now);
  const account = {
    sessionId: "device-one",
    userId: "private-account",
    userName: "Alice Account",
  };
  const secondDevice = { ...account, sessionId: "device-two" };
  service.send(account, input);
  assert.equal(service.snapshot(guest).messages[0]!.nickname, "Alice Account");
  assert.equal(service.snapshot(guest).messages[0]!.account, true);
  assert.equal(service.snapshot(secondDevice).messages[0]!.own, true);
  service.send(guest, input);
  const firstLabel = service.snapshot(guest).messages[1]!.nickname;
  assert.match(firstLabel, /^Anonymous [1-9]\d{5}$/);
  assert.equal(service.snapshot(other).messages[1]!.nickname, firstLabel);
  now = 2000;
  service.send({ ...guest, userName: "Forged guest name" }, input);
  assert.equal(service.snapshot(guest).messages[2]!.nickname, firstLabel);
  const freshService = new MessageService();
  freshService.send(guest, input);
  assert.equal(freshService.snapshot(guest).messages[0]!.nickname, firstLabel);
  freshService.send(other, input);
  assert.notEqual(
    freshService.snapshot(guest).messages[1]!.nickname,
    firstLabel,
  );
  for (const spoofed of [
    { ...input, nickname: "Impersonator" },
    { ...input, userId: account.userId },
    { ...input, userName: "Impersonator" },
  ])
    assert.throws(() => service.send(guest, spoofed));
  assert.equal(service.snapshot(guest).revision, 3);
});

void test("rolling posting limits are shared across account sessions and independent for guests", () => {
  let now = 0;
  const service = new MessageService(() => now);
  const account = {
    sessionId: "device-one",
    userId: "private-account",
    userName: "Alice",
  };
  const deviceTwo = { ...account, sessionId: "device-two" };
  service.send(account, input);
  assert.throws(() => service.send(deviceTwo, input), /Wait two seconds/);
  service.send(guest, input);
  service.send(other, input);
  now = 1999;
  assert.throws(() => service.send(guest, input), /Wait two seconds/);
  for (let count = 1; count < 10; count++) {
    now = count * 2000;
    service.send(deviceTwo, input);
  }
  now = 59_999;
  assert.throws(() => service.send(account, input), /ten per minute/);
  now = 60_000;
  service.send(account, input);
  assert.equal(
    service.snapshot(deviceTwo).messages.filter((message) => message.own)
      .length,
    11,
  );
  assert.equal(
    service.snapshot(guest).messages.filter((message) => message.own).length,
    1,
  );
  assert.ok(
    service
      .snapshot(account)
      .messages.filter((message) => message.own)
      .every((message) => message.account),
  );
  assert.equal(
    JSON.stringify(service.snapshot(guest)).includes(account.userId),
    false,
  );
  now = 200_000;
  service.send(guest, input);
});

void test("history retains the latest 100 ordered messages and resets only with a new service", () => {
  let now = 0;
  const service = new MessageService(() => now);
  const originalInstance = service.instanceId;
  for (let index = 0; index < 105; index++) {
    service.send(guest, { ...input, text: String(index) });
    now += 6000;
  }
  const snapshot = service.snapshot(guest);
  assert.equal(snapshot.messages.length, 100);
  assert.equal(snapshot.messages[0]!.text, "5");
  assert.equal(snapshot.messages.at(-1)!.text, "104");
  assert.equal(snapshot.revision, 105);
  assert.equal(snapshot.instanceId, originalInstance);
  assert.equal(
    new Set(snapshot.messages.map((message) => message.id)).size,
    100,
  );
  const restarted = new MessageService();
  assert.notEqual(restarted.instanceId, originalInstance);
  assert.equal(restarted.snapshot(guest).messages.length, 0);
  assert.equal(restarted.snapshot(guest).revision, 0);
});

void test("SSE snapshots fan out, coalesce slow consumers, recover history, and clean listeners on abort", async () => {
  let now = 0;
  const service = new MessageService(() => now);
  const abort = new AbortController();
  let notifications = 0;
  const open = (actor: MessageActor, signal: AbortSignal) =>
    gameStream({
      snapshot: () => service.snapshot(actor),
      listen: (listener) =>
        service.listen(() => {
          notifications++;
          listener();
        }),
      signal,
    });
  const first = open(guest, abort.signal);
  const second = open(other, abort.signal);
  assert.equal((await first.next()).value!.revision, 0);
  await second.next();
  service.send(guest, input);
  now = 2000;
  service.send(guest, input);
  const own = (await first.next()).value!;
  assert.equal(own.revision, 2);
  assert.equal(own.messages.length, 2);
  assert.ok(own.messages.every((message) => message.own));
  assert.ok(
    (await second.next()).value!.messages.every((message) => !message.own),
  );
  const pending = first.next();
  abort.abort();
  assert.equal((await pending).done, true);
  assert.equal((await second.next()).done, true);
  const before = notifications;
  now = 4000;
  service.send(guest, input);
  assert.equal(notifications, before);
  const reconnectAbort = new AbortController();
  const reconnected = open(guest, reconnectAbort.signal);
  const initial = (await reconnected.next()).value!;
  assert.equal(initial.messages.length, 3);
  assert.equal(initial.revision, 3);
  reconnectAbort.abort();
  await reconnected.next();
});

void test("messaging activity does not change game revisions or presence", () => {
  const game = new GameService({ log: () => undefined });
  try {
    const before = game.clients();
    const messages = new MessageService();
    const stop = messages.listen(() => undefined);
    messages.send(guest, input);
    messages.snapshot(guest);
    stop();
    const after = game.clients();
    assert.equal(after.revision, before.revision);
    assert.equal(after.count, before.count);
    assert.deepEqual(after.rooms, before.rooms);
  } finally {
    game.dispose();
  }
});
