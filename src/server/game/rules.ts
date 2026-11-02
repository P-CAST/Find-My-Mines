import { randomInt } from "node:crypto";

export const BOARD_SIZE = 6;
export const CELL_COUNT = 36;
export const BOMB_COUNT = 11;
export const TURN_MS = 10_000;
export const LEASE_MS = 15_000;
export const GRACE_MS = 15_000;

// Connectivity includes diagonals, just like the revealed neighbor counts.
export function isValidBoard(bombs: ReadonlySet<number>): boolean {
  if (
    bombs.size !== BOMB_COUNT ||
    [...bombs].some(
      (cell) => !Number.isInteger(cell) || cell < 0 || cell >= CELL_COUNT,
    )
  )
    return false;

  for (let row = 0; row < BOARD_SIZE - 1; row++) {
    for (let col = 0; col < BOARD_SIZE - 1; col++) {
      const cell = row * BOARD_SIZE + col;
      if (
        [cell, cell + 1, cell + BOARD_SIZE, cell + BOARD_SIZE + 1].every(
          (index) => bombs.has(index),
        )
      )
        return false;
    }
  }

  let top = 0;
  let left = 0;
  for (const cell of bombs) {
    if (Math.floor(cell / BOARD_SIZE) < BOARD_SIZE / 2) top++;
    if (cell % BOARD_SIZE < BOARD_SIZE / 2) left++;
  }
  if (
    [top, BOMB_COUNT - top, left, BOMB_COUNT - left].some(
      (count) => count < 3 || count > 8,
    )
  )
    return false;

  const visited = new Set<number>();
  for (const cell of bombs) {
    if (visited.has(cell)) continue;
    const pending = [cell];
    visited.add(cell);
    let size = 0;
    while (pending.length) {
      const current = pending.pop()!;
      if (++size > 5) return false;
      const row = Math.floor(current / BOARD_SIZE);
      const col = current % BOARD_SIZE;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const r = row + dr;
          const c = col + dc;
          const neighbor = r * BOARD_SIZE + c;
          if (
            r >= 0 &&
            r < BOARD_SIZE &&
            c >= 0 &&
            c < BOARD_SIZE &&
            bombs.has(neighbor) &&
            !visited.has(neighbor)
          ) {
            visited.add(neighbor);
            pending.push(neighbor);
          }
        }
      }
    }
  }
  return true;
}

export function generateBoard(
  randomIndex: (length: number) => number = (length) => randomInt(length),
): Set<number> {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    const cells = Array.from({ length: CELL_COUNT }, (_, i) => i);
    // Partial Fisher–Yates: uniformly sample eleven distinct cells.
    for (let i = 0; i < BOMB_COUNT; i++) {
      const j = i + randomIndex(CELL_COUNT - i);
      [cells[i], cells[j]] = [cells[j]!, cells[i]!];
    }
    const bombs = new Set(cells.slice(0, BOMB_COUNT));
    if (isValidBoard(bombs)) return bombs;
  }
  throw new Error(
    "Board generation failed after 1000 attempts. Please try again.",
  );
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
