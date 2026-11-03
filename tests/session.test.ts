import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { test } from "node:test";
import {
  gameSession,
  operatorLogin,
  operatorLogout,
  setGuestName,
  playerName,
} from "../src/server/game/session";

function cookie(headers: Headers) {
  return headers
    .getSetCookie()
    .map((value) => value.split(";")[0]!)
    .join("; ");
}
void test("server-issued signed cookie restores identity; a public UUID cannot impersonate it", () => {
  const output = new Headers();
  const first = gameSession(new Headers(), output);
  assert.equal(first.operator, false);
  assert.match(output.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
  assert.equal(
    gameSession(new Headers({ cookie: cookie(output) }), new Headers()).id,
    first.id,
  );
  for (const forged of [
    first.id,
    `${first.id}.fake`,
    `${randomUUID()}.${cookie(output).split(".")[1]}`,
  ]) {
    assert.notEqual(
      gameSession(
        new Headers({ cookie: `mines-session=${forged}` }),
        new Headers(),
      ).id,
      first.id,
    );
  }
});
void test("operator login requires password, is session-bound, expires, and logout clears cookie", () => {
  const oldPassword = process.env.GAME_OPERATOR_PASSWORD;
  const secret = "test-only-password-of-sufficient-length";
  process.env.GAME_OPERATOR_PASSWORD = secret;
  try {
    const playerHeaders = new Headers();
    const player = gameSession(new Headers(), playerHeaders, true);
    assert.match(playerHeaders.get("set-cookie")!, /Secure/);
    assert.throws(
      () => operatorLogin(player.id, "incorrect", new Headers(), true),
      /Incorrect/,
    );
    const operatorHeaders = new Headers();
    operatorLogin(player.id, secret, operatorHeaders, true);
    const credentials = `${cookie(playerHeaders)}; ${cookie(operatorHeaders)}`;
    assert.equal(
      gameSession(new Headers({ cookie: credentials }), new Headers()).operator,
      true,
    );
    const otherHeaders = new Headers();
    gameSession(new Headers(), otherHeaders);
    assert.equal(
      gameSession(
        new Headers({
          cookie: `${cookie(otherHeaders)}; ${cookie(operatorHeaders)}`,
        }),
        new Headers(),
      ).operator,
      false,
    );
    const expiry = String(Date.now() - 1);
    const signature = createHmac("sha256", secret)
      .update(`${player.id}.${expiry}`)
      .digest("hex");
    assert.equal(
      gameSession(
        new Headers({
          cookie: `${cookie(playerHeaders)}; mines-operator=${expiry}.${signature}`,
        }),
        new Headers(),
      ).operator,
      false,
    );
    const logoutHeaders = new Headers();
    operatorLogout(logoutHeaders, true);
    assert.match(logoutHeaders.get("set-cookie")!, /Max-Age=0/);
    assert.equal(
      gameSession(
        new Headers({
          cookie: `${cookie(playerHeaders)}; ${cookie(logoutHeaders)}`,
        }),
        new Headers(),
      ).operator,
      false,
    );
  } finally {
    if (oldPassword === undefined) delete process.env.GAME_OPERATOR_PASSWORD;
    else process.env.GAME_OPERATOR_PASSWORD = oldPassword;
  }
});

void test("guest names validate, round-trip securely, and stay fixed for the session", () => {
  const output = new Headers();
  const session = gameSession(new Headers(), output, true);
  for (const name of ["", "  ", "x".repeat(25), "bad\u0000name", "bad\nname"])
    assert.throws(() => setGuestName(session, name, new Headers()));
  assert.equal(setGuestName(session, "  Guest 🐱  ", output), "Guest 🐱");
  assert.match(
    output.getSetCookie().at(-1)!,
    /HttpOnly; SameSite=Strict; Max-Age=86400; Secure/,
  );
  const restored = gameSession(
    new Headers({ cookie: cookie(output) }),
    new Headers(),
  );
  assert.equal(restored.id, session.id);
  assert.equal(restored.guestName, "Guest 🐱");
  const unchanged = new Headers();
  assert.equal(setGuestName(restored, "Guest 🐱", unchanged), "Guest 🐱");
  assert.equal(unchanged.getSetCookie().length, 0);
  assert.throws(() => setGuestName(restored, "New name", unchanged), /fixed/);
  assert.equal(playerName("Account", restored.guestName), "Account");
  assert.equal(playerName(null, restored.guestName), "Guest 🐱");
  assert.throws(() => playerName(null, null), /homepage/);
});

void test("guest name cookies reject tampering, other sessions, malformed payloads and expiry", (t) => {
  const output = new Headers();
  const session = gameSession(new Headers(), output);
  setGuestName(session, "Alice", output);
  const credentials = cookie(output);
  const sessionCookie = credentials.split("; ")[0]!;
  const nameCookie = credentials.split("; ")[1]!;
  const value = nameCookie.slice("mines-guest-name=".length);
  const [payload, signature] = value.split(".");
  for (const forged of ["", "invalid", `${payload}.fake`, `e30.${signature}`]) {
    assert.equal(
      gameSession(
        new Headers({ cookie: `${sessionCookie}; mines-guest-name=${forged}` }),
        new Headers(),
      ).guestName,
      null,
    );
  }
  const other = new Headers();
  gameSession(new Headers(), other);
  assert.equal(
    gameSession(
      new Headers({ cookie: `${cookie(other)}; ${nameCookie}` }),
      new Headers(),
    ).guestName,
    null,
  );
  assert.equal(
    gameSession(new Headers({ cookie: nameCookie }), new Headers()).guestName,
    null,
  );
  const later = Date.now() + 86400_001;
  t.mock.method(Date, "now", () => later);
  assert.equal(
    gameSession(new Headers({ cookie: credentials }), new Headers()).guestName,
    null,
  );
});
