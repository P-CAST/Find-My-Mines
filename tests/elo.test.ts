import assert from "node:assert/strict";
import { test } from "node:test";
import { eloChange } from "../src/lib/elo";

void test("Elo uses K=32, rewards upsets, and rounds one symmetric transfer", () => {
  assert.equal(eloChange(1000, 1000, true), 16);
  assert.equal(eloChange(1000, 1000, false), -16);
  assert.equal(eloChange(1000, 1400, true), 29);
  assert.equal(eloChange(1400, 1000, true), 3);
  assert.equal(eloChange(1016, 984, true), 15);
  for (const one of [-200, 1000, 1400, 10000]) {
    for (const two of [-100, 1000, 1200]) {
      for (const won of [true, false]) {
        const delta = eloChange(one, two, won);
        assert.equal(delta + eloChange(two, one, !won), 0);
        assert.ok(Number.isInteger(delta) && Math.abs(delta) <= 32);
      }
    }
  }
});
