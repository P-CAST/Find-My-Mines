import assert from "node:assert/strict";
import { test } from "node:test";
import { TRPCError } from "@trpc/server";
import { isOperator, requireOperatorAccount } from "../src/lib/operator";
import { gameStream } from "../src/server/game/stream";

void test("only active administrator accounts receive operator access", () => {
  assert.throws(
    () => requireOperatorAccount(null),
    (error) => error instanceof TRPCError && error.code === "UNAUTHORIZED",
  );
  for (const role of [undefined, "user", "administrator", "superadmin"])
    assert.throws(
      () => requireOperatorAccount({ user: { role } }),
      (error) => error instanceof TRPCError && error.code === "FORBIDDEN",
    );
  assert.equal(isOperator({ role: "user,admin" }), true);
  assert.equal(isOperator({ role: "admin", banned: true }), false);
  assert.equal(
    isOperator({
      role: "admin",
      banned: true,
      banExpires: new Date(Date.now() + 60_000),
    }),
    false,
  );
  assert.equal(
    isOperator({ role: "admin", banned: true, banExpires: new Date(0) }),
    true,
  );
});

void test("privileged streams recheck before delivery and release listeners after access removal", async () => {
  let allowed = true;
  let listener: (() => void) | undefined;
  let subscriptions = 0;
  const stream = gameStream({
    snapshot: () => "private snapshot",
    listen: (fn) => {
      listener = fn;
      subscriptions++;
      return () => {
        if (listener) subscriptions--;
        listener = undefined;
      };
    },
    authorize: async () => {
      if (!allowed) throw new Error("Access revoked");
    },
  });
  assert.equal((await stream.next()).value, "private snapshot");
  allowed = false;
  listener!();
  await assert.rejects(stream.next(), /Access revoked/);
  assert.equal(subscriptions, 0);
});

void test("idle privileged streams close after authorization failure without a room event", async (t) => {
  let reject = false;
  let attached = false;
  const stream = gameStream({
    snapshot: () => 1,
    listen: () => {
      attached = true;
      return () => {
        attached = false;
      };
    },
    authorize: async () => {
      if (reject) throw new Error("Session expired or revoked");
    },
  });
  t.mock.timers.enable({ apis: ["setInterval"] });
  assert.equal((await stream.next()).value, 1);
  reject = true;
  const next = stream.next();
  const rejected = assert.rejects(next, /Session expired or revoked/);
  t.mock.timers.tick(5000);
  await rejected;
  assert.equal(attached, false);
});

void test("aborting a privileged stream clears its authorization timer and listener", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const controller = new AbortController();
  let checks = 0;
  let attached = false;
  const stream = gameStream({
    snapshot: () => 1,
    listen: () => {
      attached = true;
      return () => {
        attached = false;
      };
    },
    authorize: async () => {
      checks++;
    },
    signal: controller.signal,
  });
  await stream.next();
  controller.abort();
  assert.equal((await stream.next()).done, true);
  const before = checks;
  t.mock.timers.tick(10_000);
  assert.equal(checks, before);
  assert.equal(attached, false);
});
