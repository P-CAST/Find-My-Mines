import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { test } from "node:test";
import {
  gameSession,
  operatorLogin,
  operatorLogout,
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
