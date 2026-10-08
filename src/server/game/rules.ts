import { randomInt } from "node:crypto";

export const BOARD_SIZE = 6;
export const CELL_COUNT = 36;
export const BOMB_COUNT = 11;
export const TURN_MS = 10_000;
export const LEASE_MS = 15_000;
export const GRACE_MS = 15_000;

export function generateBoard(): Set<number> {
  const cells = Array.from({ length: CELL_COUNT }, (_, i) => i);
  for (let i = cells.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [cells[i], cells[j]] = [cells[j]!, cells[i]!];
  }
  return new Set(cells.slice(0, BOMB_COUNT));
}

export function adjacentBombs(bombs: ReadonlySet<number>, index: number) {
  const row = Math.floor(index / BOARD_SIZE);
  const col = index % BOARD_SIZE;
  let count = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const r = row + dr;
      const c = col + dc;
      if (
        (dr || dc) &&
        r >= 0 &&
        r < BOARD_SIZE &&
        c >= 0 &&
        c < BOARD_SIZE &&
        bombs.has(r * BOARD_SIZE + c)
      )
        count++;
    }
  }
  return count;
}
