import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { SocialService } from "../src/server/friends/service";
import { GameService, type Actor } from "../src/server/game/service";

const person = (userId: string) => ({
  userId,
  name: userId,
  publicId: randomUUID(),
});
const actor = (userId: string): Actor => ({
  userId,
  sessionId: `browser-${userId}`,
  authSessionId: `auth-${userId}`,
});

void test("social presence aggregates tabs and devices without connecting game seats", () => {
  let now = 0,
    updates = 0,
    expired = 0;
  const social = new SocialService(() => now);
  const game = new GameService({ log: () => undefined });
  const stop = social.listen("b", () => updates++);
  social.watch("b", ["a"]);
  const a = social.connect("a", "device1", () => expired++);
  const secondTab = social.connect("a", "device1", () => expired++);
  const otherDevice = social.connect("a", "device2", () => expired++);
  assert.equal(social.online("a"), true);
  assert.equal(updates, 1);
  assert.equal(game.clients().count, 0);
  a.disconnect();
  secondTab.disconnect();
  assert.equal(social.online("a"), true);
  now = 10_000;
  social.heartbeat("a", "device2");
  now = 16_000;
  assert.equal(social.online("a"), true);
  social.disconnectSession("device1");
  assert.equal(social.online("a"), true);
  social.relationship("a", "b", false);
  const before = updates;
  now = 26_000;
  social.heartbeat("a", "device2");
  assert.equal(expired, 1);
  assert.equal(social.online("a"), false);
  assert.equal(updates, before);
  otherDevice.disconnect();
  stop();
  social.dispose();
  game.dispose();
});

void test("social leases expire autonomously and session revocation closes every device tab", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const social = new SocialService();
  let closed = 0;
  social.connect("a", "session", () => closed++);
  social.connect("a", "session", () => closed++);
  social.disconnectSession("session");
  assert.equal(closed, 2);
  assert.equal(social.online("a"), false);
  social.connect("b", "other", () => closed++);
  t.mock.timers.tick(15_000);
  assert.equal(closed, 3);
  assert.equal(social.online("b"), false);
  social.dispose();
});

void test("pair operations serialize across directions and recover after rejection", async () => {
  const service = new SocialService();
  const events: number[] = [];
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = service.serial("a", "b", async () => {
    events.push(1);
    await wait;
    events.push(2);
    throw new Error("retry");
  });
  const second = service.serial("b", "a", async () => {
    events.push(3);
    return 4;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, [1]);
  release();
  await assert.rejects(first, /retry/);
  assert.equal(await second, 4);
  assert.deepEqual(events, [1, 2, 3]);
  service.dispose();
});

void test("request/search/invite limits are per account and cooldowns are symmetric", () => {
  let now = 0;
  const social = new SocialService(() => now);
  for (let i = 0; i < 5; i++) social.limit("a", "invite");
  assert.throws(() => social.limit("a", "invite"), /Too many/);
  social.limit("b", "invite");
  social.limit("a", "request");
  social.limit("a", "search");
  social.cool("a", "b", "request");
  assert.throws(
    () => social.checkCooldown("b", "a", "request"),
    /Wait a minute/,
  );
  social.checkCooldown("a", "b", "invite");
  now = 60_000;
  social.limit("a", "invite");
  social.checkCooldown("b", "a", "request");
  social.dispose();
});

void test("accepted invites reserve two account seats, start on room connections and save account results", async () => {
  const saved: unknown[] = [];
  const game = new GameService({
    log: () => undefined,
    saveResult: async (r) => {
      saved.push(r);
    },
  });
  const a = person("a"),
    b = person("b"),
    stranger = actor("stranger");
  let participantUpdates = 0,
    outsiderUpdates = 0;
  game.listen("social:a", () => participantUpdates++);
  game.listen("social:stranger", () => outsiderUpdates++);
  const invite = game.inviteFriend(a, b);
  assert.equal(participantUpdates, 1);
  assert.equal(outsiderUpdates, 0);
  assert.deepEqual(game.invitationsFor("stranger"), []);
  assert.equal(
    JSON.stringify(game.invitationsFor("a")).includes('"userId"'),
    false,
  );
  assert.deepEqual(game.inviteFriend(a, b), invite);
  assert.throws(
    () => game.acceptFriendInvitation("a", invite.id),
    /unavailable/,
  );
  assert.throws(
    () => game.invitationPair("stranger", invite.id),
    /unavailable/,
  );
  const room = game.acceptFriendInvitation("b", invite.id);
  assert.deepEqual(game.acceptFriendInvitation("b", invite.id), room);
  assert.equal(game.lobby(actor("a")).rooms.length, 0);
  assert.equal(game.snapshot(room.roomId).phase, "lobby");
  game.connect(stranger, room.roomId, () => undefined);
  assert.throws(() => game.join(stranger, room.roomId, "stranger"), /reserved/);
  game.connect(actor("a"), room.roomId, () => undefined);
  assert.equal(game.snapshot(room.roomId).phase, "lobby");
  game.connect(actor("b"), room.roomId, () => undefined);
  const state = game.snapshot(room.roomId, actor("a"));
  assert.equal(state.phase, "active");
  assert.equal(state.saveStatus, "recording");
  assert.equal(JSON.stringify(state).includes('"userId"'), false);
  game.leave(actor("a"), room.roomId);
  assert.equal(game.invitationsFor("a").length, 0);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(saved.length, 1);
  game.dispose();
});

void test("pending invites expire, cancel on room or queue entry, and cannot claim released reserved seats", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const game = new GameService({ log: () => undefined });
  const a = person("a"),
    b = person("b"),
    c = person("c");
  const expired = game.inviteFriend(a, b);
  t.mock.timers.tick(60_000);
  assert.equal(game.invitationsFor("a").length, 0);
  assert.throws(
    () => game.acceptFriendInvitation("b", expired.id),
    /unavailable/,
  );
  const pending = game.inviteFriend(a, b);
  game.connect(actor("a"), null, () => undefined);
  game.queueJoin(actor("a"), "a");
  assert.throws(
    () => game.acceptFriendInvitation("b", pending.id),
    /unavailable/,
  );
  game.queueCancel(actor("a"));
  const other = game.inviteFriend(a, b);
  assert.throws(() => game.inviteFriend(c, b), /pending invitation/);
  assert.throws(
    () => game.dismissFriendInvitation("a", other.id, "decline"),
    /unavailable/,
  );
  game.cancelFriendInvitations("b", "a");
  assert.equal(game.invitationsFor("b").length, 0);
  const accepted = game.inviteFriend(a, b);
  const { roomId } = game.acceptFriendInvitation("b", accepted.id);
  game.connect(actor("b"), roomId, () => undefined);
  // Renew only b's room presence: a never arrives and loses its seat.
  t.mock.timers.tick(10_000);
  game.heartbeat(actor("b"), roomId);
  t.mock.timers.tick(5000);
  game.connect(actor("c"), roomId, () => undefined);
  assert.throws(() => game.join(actor("c"), roomId, "c"), /reserved/);
  assert.throws(() => game.join(actor("a"), roomId, "a"), /Connect/);
  game.dispose();
});

void test(
  "PostgreSQL friends migration, authorization, literal search, pagination and cascade",
  { skip: process.env.GAME_TEST_DATABASE !== "1" },
  async () => {
    const { sql } = await import("drizzle-orm");
    const { db } = await import("../src/server/db");
    const { createFriendStore } = await import("../src/server/friends/store");
    const rollback = new Error("Rollback friends test");
    try {
      await db.transaction(async (tx) => {
        for (const file of [
          "0000_even_mariko_yashida.sql",
          "0001_premium_enchantress.sql",
          "0002_stormy_spitfire.sql",
          "0003_soft_psynapse.sql",
          "0004_white_tomas.sql",
        ]) {
          const source = (
            await readFile(
              new URL(`../drizzle/${file}`, import.meta.url),
              "utf8",
            )
          )
            .replaceAll("CREATE TABLE ", "CREATE TEMPORARY TABLE ")
            .replaceAll('REFERENCES "public".', "REFERENCES ");
          for (const statement of source.split("--> statement-breakpoint"))
            if (statement.trim()) await tx.execute(sql.raw(statement));
          if (file === "0000_even_mariko_yashida.sql")
            await tx.execute(
              sql`insert into "user" (id, name, email, email_verified, created_at, updated_at) select 'u' || n, case when n = 0 then '100%_player' else 'Duplicate Name' end, n || '@friends.test', false, now(), now() from generate_series(0, 24) n`,
            );
        }
        const store = createFriendStore(tx);
        assert.equal(
          (
            await tx.execute(
              sql`select count(*)::int as count from game_profile`,
            )
          )[0]!.count,
          25,
        );
        const search = await store.search("u0", "duplicate");
        assert.equal(search.items.length, 20);
        assert.ok(search.nextCursor);
        const second = await store.search("u0", "duplicate", search.nextCursor);
        assert.equal(second.items.length, 4);
        assert.equal(
          new Set([...search.items, ...second.items].map((i) => i.publicId))
            .size,
          24,
        );
        assert.equal((await store.search("u1", "%_")).items.length, 1);
        assert.equal((await store.search("u1", "\\")).items.length, 0);
        const other = await store.target(search.items[0]!.publicId);
        // Simulate an account created after the migration that never opened history.
        await tx.execute(sql`delete from game_profile where user_id = 'u0'`);
        assert.equal(await store.change("u0", other.userId, "send"), "pending");
        assert.equal(await store.change(other.userId, "u0", "send"), "pending");
        await assert.rejects(
          store.change("u0", other.userId, "accept"),
          /not available/,
        );
        assert.equal(await store.incomingCount(other.userId), 1);
        assert.equal(
          (await store.list(other.userId, "incoming")).items.length,
          1,
        );
        assert.equal(
          await store.change(other.userId, "u0", "accept"),
          "accepted",
        );
        assert.equal((await store.list("u0", "friends")).items.length, 1);
        assert.equal(
          (await store.search("u0", "duplicate")).items.find(
            (i) => i.publicId === other.publicId,
          )?.relationship,
          "friends",
        );
        await assert.rejects(store.change("u0", "u0", "send"), /another/);
        assert.equal(await store.change("u0", other.userId, "remove"), "none");
        await store.change("u0", other.userId, "send");
        await store.change(other.userId, "u0", "decline");
        assert.equal(await store.incomingCount(other.userId), 0);
        await store.change("u0", other.userId, "send");
        await store.change("u0", other.userId, "cancel");
        await store.change("u0", other.userId, "send");
        await assert.rejects(
          tx.transaction(async (savepoint) => {
            await savepoint.execute(
              sql`insert into friendship (account_one, account_two, requester) values ('u1', 'u1', 'u1')`,
            );
          }),
          /friendship_order/,
        );
        await assert.rejects(
          tx.transaction(async (savepoint) => {
            await savepoint.execute(
              sql`insert into friendship (account_one, account_two, requester) values ('u1', 'u2', 'u3')`,
            );
          }),
          /friendship_requester/,
        );
        await assert.rejects(
          tx.transaction(async (savepoint) => {
            await savepoint.execute(
              sql`insert into friendship (account_one, account_two, requester, status) values ('u1', 'u2', 'u1', 'invalid')`,
            );
          }),
          /friendship_status/,
        );
        await tx.execute(sql`delete from "user" where id = ${other.userId}`);
        assert.equal(await store.relationship("u0", other.userId), undefined);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      await db.$client.end({ timeout: 1 });
    }
  },
);
