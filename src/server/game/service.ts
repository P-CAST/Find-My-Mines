import { randomInt, randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import {
  adjacentBombs,
  BOMB_COUNT,
  CELL_COUNT,
  generateBoard,
  GRACE_MS,
  LEASE_MS,
  TURN_MS,
} from "./rules";

export type PublicCell =
  { kind: "covered" } | { kind: "bomb" } | { kind: "empty"; adjacent: number };
type Player = { id: string; nickname: string; score: number };
export type GameSnapshot = {
  instanceId: string;
  revision: number;
  serverNow: number;
  matchId: string;
  turnId: string;
  phase: "lobby" | "active" | "finished";
  players: (Player & { connected: boolean; reservedUntil: number | null })[];
  cells: PublicCell[];
  activePlayer: string | null;
  deadline: number | null;
  winner: string | null;
  rematchVotes: string[];
  manualStart: boolean;
  message: string;
};
export type ClientsSnapshot = {
  revision: number;
  count: number;
  clients: { id: string; nickname: string }[];
  game: GameSnapshot;
};
type Timer = ReturnType<typeof setTimeout>;
type Presence = {
  streams: Map<string, () => void>;
  expires: number;
  timer?: Timer;
};
type Reservation = { until: number; timer: Timer };
export type ServiceOptions = {
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => Timer;
  cancel?: (timer: Timer) => void;
  board?: () => Set<number>;
  firstPlayer?: () => number;
  log?: (message: string) => void;
};

/** One synchronous authority, used only by the Node tRPC route. No awaits in transitions. */
export class GameService {
  readonly instanceId = randomUUID();
  private revision = 0;
  private matchId = randomUUID();
  private turnId = randomUUID();
  private phase: GameSnapshot["phase"] = "lobby";
  private players: Player[] = [];
  private bombs = new Set<number>();
  private cells: PublicCell[] = this.covered();
  private activePlayer: string | null = null;
  private deadline: number | null = null;
  private winner: string | null = null;
  private votes = new Set<string>();
  private manualStart = false;
  private message = "Waiting for two players.";
  private turnTimer: Timer | undefined;
  private presence = new Map<string, Presence>();
  private reservations = new Map<string, Reservation>();
  private listeners = new Set<() => void>();
  private readonly now;
  private readonly schedule;
  private readonly cancel;
  private readonly board;
  private readonly firstPlayer;
  private readonly log;

  constructor(options: ServiceOptions = {}) {
    this.now = options.now ?? Date.now;
    this.schedule =
      options.schedule ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer.unref();
        return timer;
      });
    this.cancel = options.cancel ?? clearTimeout;
    this.board = options.board ?? generateBoard;
    this.firstPlayer = options.firstPlayer ?? (() => randomInt(2));
    this.log = options.log ?? console.log;
  }
  private covered(): PublicCell[] {
    return Array.from({ length: CELL_COUNT }, () => ({ kind: "covered" }));
  }
  private fail(message: string): never {
    throw new TRPCError({ code: "BAD_REQUEST", message });
  }
  private publish() {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  listen(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  snapshot(): GameSnapshot {
    return {
      instanceId: this.instanceId,
      revision: this.revision,
      serverNow: this.now(),
      matchId: this.matchId,
      turnId: this.turnId,
      phase: this.phase,
      players: this.players.map((p) => ({
        ...p,
        connected: this.presence.has(p.id),
        reservedUntil: this.reservations.get(p.id)?.until ?? null,
      })),
      cells: this.cells.map((c) => ({ ...c })),
      activePlayer: this.activePlayer,
      deadline: this.deadline,
      winner: this.winner,
      rematchVotes: [...this.votes],
      manualStart: this.manualStart,
      message: this.message,
    };
  }
  clients(): ClientsSnapshot {
    const clients = [...this.presence.keys()].map((id) => ({
      id,
      nickname: this.players.find((p) => p.id === id)?.nickname ?? "Not joined",
    }));
    return {
      revision: this.revision,
      count: clients.length,
      clients,
      game: this.snapshot(),
    };
  }
  private logPresence() {
    this.log(`[game clients] ${JSON.stringify(this.clients().clients)}`);
    this.log(`[game clients] count=${this.presence.size}`);
  }
  connect(id: string, onLeaseExpired: () => void) {
    this.checkTime();
    const stream = randomUUID();
    let presence = this.presence.get(id);
    if (!presence) {
      presence = { streams: new Map(), expires: this.now() + LEASE_MS };
      this.presence.set(id, presence);
      const reservation = this.reservations.get(id);
      if (reservation) this.cancel(reservation.timer);
      this.reservations.delete(id);
    }
    presence.streams.set(stream, onLeaseExpired);
    this.heartbeat(id);
    if (presence.streams.size === 1) {
      if (
        this.phase === "finished" &&
        this.votes.size === 2 &&
        this.players.every((p) => this.presence.has(p.id))
      )
        this.begin(this.winner!);
      this.publish();
      this.logPresence();
    }
    return () => {
      const current = this.presence.get(id);
      if (current !== presence) return;
      current.streams.delete(stream);
      if (current.streams.size === 0) this.disconnect(id);
    };
  }
  heartbeat(id: string) {
    this.checkTime();
    const presence = this.presence.get(id);
    if (!presence) this.fail("Connect to the game before sending actions.");
    if (presence.timer) this.cancel(presence.timer);
    presence.expires = this.now() + LEASE_MS;
    presence.timer = this.schedule(() => this.checkTime(), LEASE_MS);
    return { serverNow: this.now(), instanceId: this.instanceId };
  }
  private disconnect(id: string) {
    const presence = this.presence.get(id);
    if (!presence) return;
    if (presence.timer) this.cancel(presence.timer);
    this.presence.delete(id);
    for (const close of presence.streams.values()) close();
    if (this.players.some((p) => p.id === id)) {
      const until = this.now() + GRACE_MS;
      this.reservations.set(id, {
        until,
        timer: this.schedule(() => this.checkTime(), GRACE_MS),
      });
    }
    this.publish();
    this.logPresence();
  }
  private release(id: string) {
    const reservation = this.reservations.get(id);
    if (!reservation) return;
    this.cancel(reservation.timer);
    this.reservations.delete(id);
    this.players = this.players.filter((p) => p.id !== id);
    this.clearMatch(
      false,
      "A player disconnected. Waiting for a replacement; no win was awarded.",
    );
    this.publish();
  }
  private checkTime() {
    const now = this.now();
    for (const [id, presence] of this.presence)
      if (presence.expires <= now) this.disconnect(id);
    for (const [id, reservation] of this.reservations)
      if (reservation.until <= now) this.release(id);
    if (
      this.phase === "active" &&
      this.deadline !== null &&
      this.deadline <= now
    ) {
      this.newTurn(this.opponent(this.activePlayer!));
      this.publish();
    }
  }
  private player(id: string) {
    this.checkTime();
    const player = this.players.find((p) => p.id === id);
    if (!player)
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Your session does not own a player seat.",
      });
    if (!this.presence.has(id))
      this.fail("Reconnect to the game before playing.");
    return player;
  }
  join(id: string, nickname: string) {
    this.checkTime();
    nickname = nickname.trim();
    if (!nickname || nickname.length > 24 || /[\p{C}]/u.test(nickname))
      this.fail("Use a nickname of 1–24 visible characters.");
    if (!this.presence.has(id))
      this.fail("Connect to the game before joining.");
    if (this.players.some((p) => p.id === id)) return this.snapshot();
    if (this.players.length === 2)
      this.fail("Game full. Both player seats are occupied.");
    this.players.push({ id, nickname, score: 0 });
    if (this.players.length === 2 && !this.manualStart) this.begin();
    this.publish();
    this.logPresence();
    return this.snapshot();
  }
  private opponent(id: string) {
    return this.players.find((p) => p.id !== id)!.id;
  }
  private stopTimer() {
    if (this.turnTimer) this.cancel(this.turnTimer);
    this.turnTimer = undefined;
  }
  private newTurn(id: string) {
    this.stopTimer();
    this.activePlayer = id;
    this.turnId = randomUUID();
    this.deadline = this.now() + TURN_MS;
    const match = this.matchId;
    const turn = this.turnId;
    this.turnTimer = this.schedule(() => {
      if (
        match === this.matchId &&
        turn === this.turnId &&
        this.phase === "active"
      )
        this.checkTime();
    }, TURN_MS);
  }
  private begin(first?: string) {
    this.stopTimer();
    this.matchId = randomUUID();
    this.cells = this.covered();
    this.bombs = this.board();
    this.players.forEach((p) => {
      p.score = 0;
    });
    this.votes.clear();
    this.winner = null;
    this.phase = "active";
    this.manualStart = false;
    this.message = "Find all 11 bombs.";
    this.newTurn(first ?? this.players[this.firstPlayer()]!.id);
  }
  reveal(
    id: string,
    input: { matchId: string; turnId: string; cellIndex: number },
  ) {
    const player = this.player(id);
    if (this.phase !== "active") this.fail("The match is not active.");
    if (input.matchId !== this.matchId || input.turnId !== this.turnId)
      this.fail("This turn has expired or changed. Use the latest board.");
    if (id !== this.activePlayer) this.fail("It is not your turn.");
    const index = input.cellIndex;
    if (!Number.isInteger(index) || index < 0 || index >= CELL_COUNT)
      this.fail("Invalid cell.");
    if (this.cells[index]!.kind !== "covered")
      this.fail("That cell has already been revealed.");
    if (this.bombs.has(index)) {
      this.cells[index] = { kind: "bomb" };
      player.score++;
      if (this.players.reduce((sum, p) => sum + p.score, 0) === BOMB_COUNT) {
        this.phase = "finished";
        this.winner = this.players.reduce((a, b) =>
          a.score > b.score ? a : b,
        ).id;
        this.stopTimer();
        this.deadline = null;
        this.activePlayer = null;
        this.turnId = randomUUID();
        this.message = "All 11 bombs found.";
      }
    } else {
      this.cells[index] = {
        kind: "empty",
        adjacent: adjacentBombs(this.bombs, index),
      };
      this.newTurn(this.opponent(id));
    }
    this.publish();
    return this.snapshot();
  }
  rematch(id: string, matchId: string) {
    this.player(id);
    if (this.phase !== "finished" || matchId !== this.matchId)
      this.fail("This result is no longer current.");
    this.votes.add(id);
    if (
      this.votes.size === 2 &&
      this.players.every((p) => this.presence.has(p.id))
    )
      this.begin(this.winner!);
    this.publish();
    return this.snapshot();
  }
  private clearMatch(manualStart: boolean, message: string) {
    this.stopTimer();
    this.matchId = randomUUID();
    this.turnId = randomUUID();
    this.phase = "lobby";
    this.bombs.clear();
    this.cells = this.covered();
    this.players.forEach((p) => {
      p.score = 0;
    });
    this.activePlayer = null;
    this.deadline = null;
    this.winner = null;
    this.votes.clear();
    this.manualStart = manualStart;
    this.message = message;
  }
  reset() {
    this.checkTime();
    for (const [id, reservation] of this.reservations) {
      this.cancel(reservation.timer);
      this.players = this.players.filter((p) => p.id !== id);
    }
    this.reservations.clear();
    this.clearMatch(true, "Operator reset. Waiting for the operator to start.");
    this.publish();
    return this.snapshot();
  }
  start() {
    this.checkTime();
    if (this.phase !== "lobby" || !this.manualStart)
      this.fail("Start is available only after an operator reset.");
    if (
      this.players.length !== 2 ||
      !this.players.every((p) => this.presence.has(p.id))
    )
      this.fail("Two connected players are required.");
    this.begin();
    this.publish();
    return this.snapshot();
  }
  dispose() {
    this.stopTimer();
    for (const p of this.presence.values()) {
      if (p.timer) this.cancel(p.timer);
    }
    for (const r of this.reservations.values()) this.cancel(r.timer);
    this.presence.clear();
    this.reservations.clear();
    this.listeners.clear();
  }
}

// Next dev re-evaluates modules. Keep the authority (including its timers/listeners) on globalThis.
const globalGame = globalThis as typeof globalThis & {
  findMyMinesGame?: GameService;
};
export const game = (globalGame.findMyMinesGame ??= new GameService());

// Refresh methods on hot reload without recreating state, timers, or listeners.
Object.setPrototypeOf(game, GameService.prototype);
