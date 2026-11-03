/** Seat one's integer change; the other seat receives its exact opposite. */
export function eloChange(one: number, two: number, oneWon: boolean): number {
  const winner = oneWon ? one : two;
  const loser = oneWon ? two : one;
  const expected = 1 / (1 + 10 ** ((loser - winner) / 400));
  const change = Math.round(32 * (1 - expected));
  return oneWon ? change : -change;
}
