import { randomInt, randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import type { BotProvider } from "./bot";
import {
  adjacentBombs,
  BOMB_COUNT,
  CELL_COUNT,
  generateBoard,
  GRACE_MS,
  LEASE_MS,
  TURN_MS,
} from "./rules";

export const ACCOUNT_WAIT_MS = 30_000;
export type Actor = {
  sessionId: string;
  userId: string | null;
  authSessionId?: string;
};
export type PublicCell =
  { kind: "covered" } | { kind: "bomb" } | { kind: "empty"; adjacent: number };
export type Visibility = "public" | "unlisted";
export type SaveStatus =
  "unrecorded" | "recording" | "pending" | "saved" | "failed";
export type GameSnapshot = {
  instanceId: string;
  roomId: string;
  visibility: Visibility;
  mode: "human" | "bot";
  revision: number;
  serverNow: number;
  viewerId: string | null;
  matchId: string;
  turnId: string;
  phase: "lobby" | "active" | "finished" | "closed";
  players: {
    id: string;
    nickname: string;
    score: number;
    account: boolean;
    bot?: true;
    seated: boolean;
    connected: boolean;
    reservedUntil: number | null;
  }[];
  cells: PublicCell[];
  activePlayer: string | null;
  deadline: number | null;
  winner: string | null;
  rematchVotes: string[];
  manualStart: boolean;
  message: string;
  resultReason: "completed" | "forfeit" | null;
  saveStatus: SaveStatus;
};
export type RoomSummary = Pick<
  GameSnapshot,
  "roomId" | "visibility" | "phase" | "manualStart" | "saveStatus"
> & {
  players: Pick<
    GameSnapshot["players"][number],
    "nickname" | "account" | "connected"
  >[];
};
export type LobbySnapshot = {
  instanceId: string;
  revision: number;
  serverNow: number;
  rooms: RoomSummary[];
  roomId: string | null;
  queuedAt: number | null;
  account: boolean;
  bot: {
    available: boolean;
    remaining: number;
    nextAvailableAt: number | null;
  };
};
export type ClientsSnapshot = {
  instanceId: string;
  revision: number;
  count: number;
  queued: number;
  rooms: RoomSummary[];
  clients: { id: string; nickname: string; roomId: string | null }[];
  pendingSaves: number;
  failedSaves: number;
};
export type ReplayFrame = {
  sequence: number;
  elapsedMs: number;
  event: "start" | "reveal" | "timeout" | "presence" | "forfeit";
  cellIndex?: number;
  state: Pick<
    GameSnapshot,
    | "players"
    | "cells"
    | "activePlayer"
    | "deadline"
    | "winner"
    | "phase"
    | "resultReason"
  >;
};
export type MatchRecord = {
  matchId: string;
  playerOneId: string;
  playerTwoId: string;
  playerOneName: string;
  playerTwoName: string;
  playerOneScore: number;
  playerTwoScore: number;
  winnerSeat: number;
  startedAt: Date;
  finishedAt: Date;
  reason: "completed" | "forfeit";
  replay: { version: 1; frames: ReplayFrame[] };
};
type Timer = ReturnType<typeof setTimeout>;
type Player = {
  bot?: true;
  id: string;
  key: string;
  userId: string | null;
  nickname: string;
  score: number;
  seated: boolean;
  reservedUntil: number | null;
};
type BotJob = {
  key: string;
  controller: AbortController;
  timer?: Timer;
};
type Room = {
  mode: "human" | "bot";
  botJob?: BotJob;
  botAttempts: Set<string>;
  botCalls: number;
  id: string;
  visibility: Visibility;
  revision: number;
  matchId: string;
  turnId: string;
  phase: GameSnapshot["phase"];
  players: Player[];
  bombs: Set<number>;
  cells: PublicCell[];
  activePlayer: string | null;
  deadline: number | null;
  winner: string | null;
  votes: Set<string>;
  manualStart: boolean;
  message: string;
  resultReason: GameSnapshot["resultReason"];
  saveStatus: SaveStatus;
  startedAt: number;
  frames: ReplayFrame[];
  timer?: Timer;
};
type Presence = {
  actor: Actor;
  timer?: Timer;
  streams: Map<
    string,
    { roomId: string | null; expires: number; close: () => void }
  >;
};
type QueueEntry = {
  key: string;
  userId: string | null;
  nickname: string;
  joinedAt: number;
};
export type ServiceOptions = {
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => Timer;
  cancel?: (timer: Timer) => void;
  board?: () => Set<number>;
  firstPlayer?: () => number;
  log?: (message: string) => void;
  saveResult?: (record: MatchRecord) => Promise<void>;
  botProvider?: BotProvider;
  randomIndex?: (length: number) => number;
};
const keyOf = (actor: Actor) =>
  actor.userId ? `account:${actor.userId}` : `guest:${actor.sessionId}`;
const covered = (): PublicCell[] =>
  Array.from({ length: CELL_COUNT }, () => ({ kind: "covered" }));

/** One process-wide, synchronous authority. Database writes run after transitions. */
export class GameService {
  readonly runtimeVersion = 3;
  readonly instanceId = randomUUID();
  private revision = 0;
  private rooms = new Map<string, Room>();
  private membership = new Map<string, string>();
  private presence = new Map<string, Presence>();
  private queue = new Map<string, QueueEntry>();
  private listeners = new Map<string, Set<() => void>>();
  private pending = new Map<
    string,
    { record: MatchRecord; failed: boolean; saving: boolean; timer?: Timer }
  >();
  private queueTimer?: Timer;
  private botQuotaTimer?: Timer;
  private botGames: number[] = [];
  private botProvider?: BotProvider;
  private readonly randomIndex;

  private checking = false;
  private disposed = false;
  private readonly now;
  private readonly schedule;
  private readonly cancel;
  private readonly board;
  private readonly firstPlayer;
  private readonly log;
  private writer?: ServiceOptions["saveResult"];
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
    this.writer = options.saveResult;
    this.botProvider = options.botProvider;
    this.randomIndex =
      options.randomIndex ?? ((length: number) => randomInt(length));
  }
  setResultWriter(writer: NonNullable<ServiceOptions["saveResult"]>) {
    this.writer = writer;
  }
  setBotProvider(provider: BotProvider | undefined) {
    this.botProvider = provider;
  }
  private botAvailability() {
    const recent = this.botGames.filter(
      (time) => time + 3_600_000 > this.now(),
    );
    return {
      available: !!this.botProvider,
      remaining: Math.max(0, 3 - recent.length),
      nextAvailableAt: recent.length >= 3 ? recent[0]! + 3_600_000 : null,
    };
  }
  private reserveBotGame() {
    const availability = this.botAvailability();
    if (!availability.available)
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "Bot play is not configured.",
      });
    if (!availability.remaining) {
      this.log("[bot] quota_rejected");
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: `The shared limit of 3 bot games per hour has been reached. Try again after ${new Date(availability.nextAvailableAt!).toISOString()}.`,
      });
    }
    this.botGames = this.botGames.filter(
      (time) => time + 3_600_000 > this.now(),
    );
    this.botGames.push(this.now());
    this.armBotQuota();
  }
  private armBotQuota() {
    this.cancelTimer(this.botQuotaTimer);
    const first = this.botGames[0];
    if (first === undefined) return;
    this.botQuotaTimer = this.schedule(
      () => {
        this.botGames = this.botGames.filter(
          (time) => time + 3_600_000 > this.now(),
        );
        this.armBotQuota();
        this.publish();
      },
      Math.max(0, first + 3_600_000 - this.now()),
    );
  }
  private fail(
    message: string,
    code: "BAD_REQUEST" | "NOT_FOUND" | "FORBIDDEN" = "BAD_REQUEST",
  ): never {
    throw new TRPCError({ code, message });
  }
  private room(id: string) {
    const room = this.rooms.get(id);
    if (!room)
      this.fail("This room has closed. Return to the lobby.", "NOT_FOUND");
    return room;
  }
  private validateName(nickname: string) {
    nickname = nickname.trim();
    if (!nickname || nickname.length > 24 || /[\p{C}]/u.test(nickname))
      this.fail("Use a nickname of 1–24 visible characters.");
    return nickname;
  }
  listen(scope: string, listener: () => void) {
    const listeners = this.listeners.get(scope) ?? new Set<() => void>();
    this.listeners.set(scope, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(scope);
    };
  }
  private publish(room?: Room) {
    this.revision++;
    if (room) {
      this.syncBot(room);
      room.revision = this.revision;
      for (const listener of this.listeners.get(room.id) ?? []) listener();
    }
    for (const scope of ["lobby", "operator"])
      for (const listener of this.listeners.get(scope) ?? []) listener();
  }
  private connected(key: string, roomId: string | null) {
    if (
      roomId &&
      this.rooms
        .get(roomId)
        ?.players.some((p) => p.key === key && p.bot && p.seated)
    )
      return true;
    return [...this.presence.values()].some(
      (p) =>
        keyOf(p.actor) === key &&
        [...p.streams.values()].some(
          (s) => s.roomId === roomId && s.expires > this.now(),
        ),
    );
  }
  private authenticatedPresence(actor: Actor) {
    const p = this.presence.get(actor.sessionId);
    if (
      p &&
      (keyOf(p.actor) !== keyOf(actor) ||
        p.actor.authSessionId !== actor.authSessionId)
    ) {
      this.disconnectSession(actor.sessionId);
      this.fail("Your account changed. Reconnect before playing.");
    }
    if (!p) this.fail("Connect to the lobby or room before sending actions.");
    return p;
  }
  snapshot(roomId: string, actor?: Actor): GameSnapshot {
    const r = this.room(roomId);
    return this.roomSnapshot(r, actor);
  }
  private roomSnapshot(r: Room, actor?: Actor): GameSnapshot {
    return {
      instanceId: this.instanceId,
      roomId: r.id,
      visibility: r.visibility,
      mode: r.mode,
      revision: r.revision,
      serverNow: this.now(),
      viewerId: actor
        ? (r.players.find((p) => p.key === keyOf(actor) && p.seated)?.id ??
          null)
        : null,
      matchId: r.matchId,
      turnId: r.turnId,
      phase: r.phase,
      players: r.players.map((p) => ({
        id: p.id,
        nickname: p.nickname,
        score: p.score,
        account: !!p.userId,
        ...(p.bot ? { bot: true as const } : {}),
        seated: p.seated,
        connected: p.seated && this.connected(p.key, r.id),
        reservedUntil: p.reservedUntil,
      })),
      cells: r.cells.map((c) => ({ ...c })),
      activePlayer: r.activePlayer,
      deadline: r.deadline,
      winner: r.winner,
      rematchVotes: [...r.votes],
      manualStart: r.manualStart,
      message: r.message,
      resultReason: r.resultReason,
      saveStatus: r.saveStatus,
    };
  }
  private summary(r: Room): RoomSummary {
    return {
      roomId: r.id,
      visibility: r.visibility,
      phase: r.phase,
      manualStart: r.manualStart,
      saveStatus: r.saveStatus,
      players: r.players
        .filter((p) => p.seated)
        .map((p) => ({
          nickname: p.nickname,
          account: !!p.userId,
          connected: this.connected(p.key, r.id),
        })),
    };
  }
  lobby(actor: Actor): LobbySnapshot {
    return {
      instanceId: this.instanceId,
      revision: this.revision,
      serverNow: this.now(),
      account: !!actor.userId,
      bot: this.botAvailability(),
      rooms: [...this.rooms.values()]
        .filter((r) => r.visibility === "public")
        .map((r) => this.summary(r)),
      roomId: this.membership.get(keyOf(actor)) ?? null,
      queuedAt: this.queue.get(keyOf(actor))?.joinedAt ?? null,
    };
  }
  clients(): ClientsSnapshot {
    const clients = [...this.presence.entries()].map(([id, p]) => {
      const roomId = this.membership.get(keyOf(p.actor)) ?? null;
      const player = roomId
        ? this.rooms
            .get(roomId)
            ?.players.find((player) => player.key === keyOf(p.actor))
        : undefined;
      return {
        id,
        nickname:
          player?.nickname ??
          this.queue.get(keyOf(p.actor))?.nickname ??
          "Not joined",
        roomId,
      };
    });
    return {
      instanceId: this.instanceId,
      revision: this.revision,
      count: clients.length,
      clients,
      queued: this.queue.size,
      rooms: [...this.rooms.values()].map((r) => this.summary(r)),
      pendingSaves: this.pending.size,
      failedSaves: [...this.pending.values()].filter((p) => p.failed).length,
    };
  }
  connect(actor: Actor, roomId: string | null, onLeaseExpired: () => void) {
    this.checkTime();
    if (roomId) this.room(roomId);
    let p = this.presence.get(actor.sessionId);
    if (
      p &&
      (keyOf(p.actor) !== keyOf(actor) ||
        p.actor.authSessionId !== actor.authSessionId)
    ) {
      this.disconnectSession(actor.sessionId);
      p = undefined;
    }
    if (!p) {
      p = {
        actor: { ...actor },
        streams: new Map(),
      };
      this.presence.set(actor.sessionId, p);
    }
    const streamId = randomUUID();
    p.streams.set(streamId, {
      roomId,
      expires: this.now() + LEASE_MS,
      close: onLeaseExpired,
    });
    this.renew(p, roomId);
    if (roomId) this.updatePresence(this.room(roomId));
    this.publish();
    this.logPresence();
    const presence = p;
    return () => {
      if (
        this.presence.get(actor.sessionId) !== presence ||
        !presence.streams.delete(streamId)
      )
        return;
      if (!presence.streams.size) {
        this.cancelTimer(presence.timer);
        this.presence.delete(actor.sessionId);
      } else this.armPresence(presence);
      if (roomId && this.rooms.has(roomId))
        this.updatePresence(this.room(roomId));
      this.pruneQueue();
      this.publish();
      this.logPresence();
    };
  }
  private armPresence(p: Presence) {
    this.cancelTimer(p.timer);
    const expiry = Math.min(...[...p.streams.values()].map((s) => s.expires));
    p.timer = this.schedule(
      () => this.checkTime(),
      Math.max(0, expiry - this.now()),
    );
  }
  private renew(p: Presence, roomId: string | null) {
    const streams = [...p.streams.values()].filter((s) => s.roomId === roomId);
    if (!streams.length)
      this.fail("Reconnect to this page before sending heartbeats.");
    for (const stream of streams) stream.expires = this.now() + LEASE_MS;
    this.armPresence(p);
  }
  heartbeat(actor: Actor, roomId: string | null = null) {
    this.checkTime();
    this.renew(this.authenticatedPresence(actor), roomId);
    return { serverNow: this.now(), instanceId: this.instanceId };
  }
  private disconnectSession(id: string) {
    const p = this.presence.get(id);
    if (!p) return;
    this.cancelTimer(p.timer);
    this.presence.delete(id);
    const scopes = new Set([...p.streams.values()].map((s) => s.roomId));
    for (const s of p.streams.values()) s.close();
    for (const roomId of scopes)
      if (roomId && this.rooms.has(roomId))
        this.updatePresence(this.room(roomId));
    this.pruneQueue();
    this.publish();
    this.logPresence();
  }
  private logPresence() {
    const { count, clients } = this.clients();
    this.log(`[game clients] ${JSON.stringify({ count, clients })}`);
  }
  private cancelTimer(timer?: Timer) {
    if (timer !== undefined) this.cancel(timer);
  }
  private updatePresence(r: Room) {
    for (const p of r.players)
      if (p.seated) {
        if (this.connected(p.key, r.id)) p.reservedUntil = null;
        else p.reservedUntil ??= this.now() + GRACE_MS;
      }
    this.maybeBegin(r);
    this.frame(r, "presence");
    this.arm(r);
    this.publish(r);
  }
  private arm(r: Room) {
    this.cancelTimer(r.timer);
    r.timer = undefined;
    const times = r.players
      .filter((p) => p.seated && p.reservedUntil !== null)
      .map((p) => p.reservedUntil!);
    if (r.deadline !== null) times.push(r.deadline);
    if (!times.length) return;
    const matchId = r.matchId,
      turnId = r.turnId;
    r.timer = this.schedule(
      () => {
        if (
          this.rooms.get(r.id) === r &&
          r.matchId === matchId &&
          r.turnId === turnId
        )
          this.checkTime();
      },
      Math.max(0, Math.min(...times) - this.now()),
    );
  }
  private checkTime() {
    if (this.checking || this.disposed) return;
    this.checking = true;
    try {
      for (const [id, p] of this.presence) {
        const expired = [...p.streams.entries()].filter(
          ([, s]) => s.expires <= this.now(),
        );
        if (!expired.length) continue;
        for (const [streamId] of expired) p.streams.delete(streamId);
        if (!p.streams.size) {
          this.cancelTimer(p.timer);
          this.presence.delete(id);
        } else this.armPresence(p);
        for (const [, stream] of expired) stream.close();
        for (const roomId of new Set(expired.map(([, s]) => s.roomId))) {
          if (roomId && this.rooms.has(roomId))
            this.updatePresence(this.room(roomId));
        }
        this.publish();
        this.logPresence();
      }
      for (const r of [...this.rooms.values()]) {
        const expired = r.players.filter(
          (p) =>
            p.seated &&
            p.reservedUntil !== null &&
            p.reservedUntil <= this.now(),
        );
        if (expired.length && r.phase === "active") {
          const remaining = r.players.find(
            (p) =>
              p.seated && !expired.includes(p) && this.connected(p.key, r.id),
          );
          if (remaining) this.finish(r, remaining.id, "forfeit");
          else
            this.clearMatch(
              r,
              false,
              "Both players disconnected. No winner was awarded.",
            );
        }
        for (const p of expired) this.release(r, p);
        if (!this.rooms.has(r.id)) continue;
        if (
          r.phase === "active" &&
          r.deadline !== null &&
          r.deadline <= this.now()
        ) {
          this.newTurn(r, this.opponent(r, r.activePlayer!).id);
          this.frame(r, "timeout");
          this.publish(r);
        }
        this.arm(r);
      }
      this.pruneQueue();
      this.matchmake();
    } finally {
      this.checking = false;
    }
  }
  private newRoom(visibility: Visibility) {
    const r: Room = {
      id: randomUUID(),
      visibility,
      mode: "human",
      botAttempts: new Set(),
      botCalls: 0,
      revision: 0,
      matchId: randomUUID(),
      turnId: randomUUID(),
      phase: "lobby",
      players: [],
      bombs: new Set(),
      cells: covered(),
      activePlayer: null,
      deadline: null,
      winner: null,
      votes: new Set(),
      manualStart: false,
      message: "Waiting for two connected players.",
      resultReason: null,
      saveStatus: "unrecorded",
      startedAt: 0,
      frames: [],
    };
    this.rooms.set(r.id, r);
    return r;
  }
  private addPlayer(
    r: Room,
    key: string,
    userId: string | null,
    nickname: string,
  ) {
    r.players.push({
      key,
      userId,
      id: randomUUID(),
      nickname,
      score: 0,
      seated: true,
      reservedUntil: this.connected(key, r.id) ? null : this.now() + GRACE_MS,
    });
    this.membership.set(key, r.id);
    this.arm(r);
  }
  create(actor: Actor, nickname: string, visibility: Visibility) {
    this.checkTime();
    this.authenticatedPresence(actor);
    nickname = this.validateName(nickname);
    const existing = this.membership.get(keyOf(actor));
    if (existing) return { roomId: existing };
    if (this.queue.has(keyOf(actor)))
      this.fail("Cancel matchmaking before creating a room.");
    const r = this.newRoom(visibility);
    this.addPlayer(r, keyOf(actor), actor.userId, nickname);
    this.publish(r);
    return { roomId: r.id };
  }
  createBot(actor: Actor, nickname: string) {
    this.checkTime();
    this.authenticatedPresence(actor);
    nickname = this.validateName(nickname);
    const existing = this.membership.get(keyOf(actor));
    if (existing) {
      if (this.room(existing).mode === "bot") return { roomId: existing };
      this.fail("Leave your current room before playing with a bot.");
    }
    if (this.queue.has(keyOf(actor)))
      this.fail("Cancel matchmaking before playing with a bot.");
    if (!this.connected(keyOf(actor), null))
      this.fail("Open the lobby before playing with a bot.");
    this.reserveBotGame();
    const r = this.newRoom("unlisted");
    r.mode = "bot";
    this.addPlayer(r, keyOf(actor), actor.userId, nickname);
    r.players.push({
      id: randomUUID(),
      key: `bot:${r.id}`,
      userId: null,
      bot: true,
      nickname: "OpenAI Bot",
      score: 0,
      seated: true,
      reservedUntil: null,
    });
    this.publish(r);
    return { roomId: r.id };
  }
  join(actor: Actor, roomId: string, nickname: string) {
    this.checkTime();
    this.authenticatedPresence(actor);
    nickname = this.validateName(nickname);
    const r = this.room(roomId),
      key = keyOf(actor),
      existing = this.membership.get(key);
    if (existing === roomId) return this.snapshot(roomId, actor);
    if (existing || this.queue.has(key))
      this.fail("Leave your current room or queue before joining another.");
    if (r.mode === "bot" || r.phase !== "lobby" || r.players.length >= 2)
      this.fail(
        "Game full. Both player seats are occupied or this match has ended.",
      );
    this.addPlayer(r, key, actor.userId, nickname);
    this.maybeBegin(r);
    this.publish(r);
    this.logPresence();
    return this.snapshot(roomId, actor);
  }
  queueJoin(actor: Actor, nickname: string) {
    this.checkTime();
    this.authenticatedPresence(actor);
    nickname = this.validateName(nickname);
    const key = keyOf(actor);
    if (this.membership.has(key)) return this.lobby(actor);
    if (!this.connected(key, null))
      this.fail("Open the lobby before finding an opponent.");
    if (!this.queue.has(key))
      this.queue.set(key, {
        key,
        userId: actor.userId,
        nickname,
        joinedAt: this.now(),
      });
    this.matchmake();
    this.publish();
    return this.lobby(actor);
  }
  queueCancel(actor: Actor) {
    this.checkTime();
    this.queue.delete(keyOf(actor));
    this.matchmake();
    this.publish();
    return this.lobby(actor);
  }
  private pruneQueue() {
    let changed = false;
    for (const [key] of this.queue)
      if (!this.connected(key, null)) {
        this.queue.delete(key);
        changed = true;
      }
    if (changed) this.publish();
  }
  private matchmake() {
    this.cancelTimer(this.queueTimer);
    this.queueTimer = undefined;
    const pair = (a: QueueEntry, b: QueueEntry) => {
      this.queue.delete(a.key);
      this.queue.delete(b.key);
      const r = this.newRoom("unlisted");
      for (const entry of [a, b])
        this.addPlayer(r, entry.key, entry.userId, entry.nickname);
      this.publish(r);
    };
    for (const accounts of [true, false]) {
      const entries = [...this.queue.values()].filter(
        (e) => !!e.userId === accounts,
      );
      for (let i = 0; i + 1 < entries.length; i += 2)
        pair(entries[i]!, entries[i + 1]!);
    }
    const accounts = [...this.queue.values()].filter((e) => e.userId);
    const guests = [...this.queue.values()].filter((e) => !e.userId);
    while (
      accounts[0] &&
      guests[0] &&
      accounts[0].joinedAt + ACCOUNT_WAIT_MS <= this.now()
    )
      pair(accounts.shift()!, guests.shift()!);
    if (accounts[0] && guests[0])
      this.queueTimer = this.schedule(
        () => {
          this.checkTime();
          this.publish();
        },
        Math.max(0, accounts[0].joinedAt + ACCOUNT_WAIT_MS - this.now()),
      );
  }
  private maybeBegin(r: Room) {
    if (
      r.players.length !== 2 ||
      !r.players.every((p) => p.seated && this.connected(p.key, r.id))
    )
      return;
    if (r.phase === "lobby" && !r.manualStart) this.begin(r);
    else if (
      r.phase === "finished" &&
      r.resultReason === "completed" &&
      r.votes.size === 2
    )
      this.begin(r, r.winner!);
  }
  private begin(r: Room, first?: string) {
    // Generate before changing any match state; failure must not start a game.
    let bombs: Set<number>;
    try {
      bombs = this.board();
    } catch {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Board generation failed. Please try again.",
      });
    }
    this.cancelBot(r);
    r.botAttempts.clear();
    r.botCalls = 0;
    r.matchId = randomUUID();
    r.phase = "active";
    r.cells = covered();
    r.bombs = bombs;
    r.players.forEach((p) => {
      p.score = 0;
    });
    r.winner = null;
    r.votes.clear();
    r.manualStart = false;
    r.resultReason = null;
    r.message = "Find all 11 bombs.";
    r.startedAt = this.now();
    r.frames = [];
    r.saveStatus = r.players.every((p) => p.userId)
      ? "recording"
      : "unrecorded";
    this.newTurn(r, first ?? r.players[this.firstPlayer()]!.id);
    this.frame(r, "start");
  }
  private newTurn(r: Room, id: string) {
    r.activePlayer = id;
    r.turnId = randomUUID();
    r.deadline = this.now() + TURN_MS;
    this.arm(r);
  }
  private opponent(r: Room, id: string) {
    return r.players.find((p) => p.id !== id)!;
  }
  private player(actor: Actor, r: Room) {
    const p = r.players.find((p) => p.key === keyOf(actor) && p.seated);
    if (!p)
      this.fail(
        "Your session does not own a player seat in this room.",
        "FORBIDDEN",
      );
    this.authenticatedPresence(actor);
    if (!this.connected(p.key, r.id))
      this.fail("Reconnect to the room before playing.");
    return p;
  }
  reveal(
    actor: Actor,
    input: {
      roomId: string;
      matchId: string;
      turnId: string;
      cellIndex: number;
    },
  ) {
    this.checkTime();
    const r = this.room(input.roomId),
      p = this.player(actor, r);
    if (r.phase !== "active") this.fail("The match is not active.");
    if (input.matchId !== r.matchId || input.turnId !== r.turnId)
      this.fail("This turn has expired or changed. Use the latest board.");
    if (r.activePlayer !== p.id) this.fail("It is not your turn.");
    this.applyReveal(r, p, input.cellIndex);
    return this.snapshot(r.id, actor);
  }
  private applyReveal(r: Room, p: Player, index: number, fallback = false) {
    if (!Number.isInteger(index) || index < 0 || index >= CELL_COUNT)
      this.fail("Invalid cell.");
    if (r.cells[index]!.kind !== "covered")
      this.fail("That cell has already been revealed.");
    r.message = fallback
      ? "The bot used a fallback move."
      : "Find all 11 bombs.";
    if (r.bombs.has(index)) {
      r.cells[index] = { kind: "bomb" };
      p.score++;
      if (
        r.players.reduce((sum, player) => sum + player.score, 0) === BOMB_COUNT
      ) {
        this.finish(
          r,
          r.players.reduce((a, b) => (a.score > b.score ? a : b)).id,
          "completed",
          index,
        );
      } else this.frame(r, "reveal", index);
    } else {
      r.cells[index] = {
        kind: "empty",
        adjacent: adjacentBombs(r.bombs, index),
      };
      this.newTurn(r, this.opponent(r, p.id).id);
      this.frame(r, "reveal", index);
    }
    this.publish(r);
  }
  private cancelBot(r: Room) {
    const job = r.botJob;
    if (!job) return;
    r.botJob = undefined;
    this.cancelTimer(job.timer);
    job.controller.abort();
  }
  private botKey(r: Room) {
    return `${r.matchId}:${r.turnId}:${r.cells.filter((cell) => cell.kind !== "covered").length}`;
  }
  private botReady(r: Room) {
    return (
      !this.disposed &&
      this.rooms.get(r.id) === r &&
      r.mode === "bot" &&
      r.phase === "active" &&
      r.deadline !== null &&
      r.deadline > this.now() &&
      r.players.some((p) => p.bot && p.seated && p.id === r.activePlayer) &&
      r.players.some((p) => !p.bot && p.seated && this.connected(p.key, r.id))
    );
  }
  private syncBot(r: Room) {
    if (r.mode !== "bot") return;
    const key = this.botKey(r);
    if (r.botJob && (!this.botReady(r) || r.botJob.key !== key))
      this.cancelBot(r);
    if (!this.botReady(r) || r.botJob) return;
    const job: BotJob = { key, controller: new AbortController() };
    r.botJob = job;
    job.timer = this.schedule(() => {
      this.checkTime();
      if (r.botJob !== job || !this.botReady(r)) return;
      const budget = r.deadline! - this.now();
      const complete = (index: number | null, category: string) => {
        this.checkTime();
        if (r.botJob !== job || !this.botReady(r) || this.botKey(r) !== key)
          return;
        this.cancelBot(r);
        const fallback =
          index === null ||
          !Number.isInteger(index) ||
          r.cells[index]?.kind !== "covered";
        if (fallback) {
          const choices = r.cells.flatMap((cell, i) =>
            cell.kind === "covered" ? [i] : [],
          );
          if (!choices.length) return;
          index = choices[this.randomIndex(choices.length)]!;
          this.log(`[bot] fallback ${category}`);
        }
        const bot = r.players.find((p) => p.bot)!;
        this.applyReveal(r, bot, index!, fallback);
      };
      if (
        budget <= 0 ||
        r.botAttempts.has(key) ||
        r.botCalls >= 36 ||
        !this.botProvider
      ) {
        complete(null, "request_unavailable");
        return;
      }
      r.botAttempts.add(key);
      r.botCalls++;
      const bot = r.players.find((p) => p.bot)!;
      const evidence = {
        cells: r.cells.map((cell) => ({ ...cell })),
        scores: { self: bot.score, opponent: this.opponent(r, bot.id).score },
        remainingMs: r.deadline! - this.now(),
      };
      const provider = this.botProvider;
      // The normal turn transition cancels this job; expiry never reveals a fallback cell.
      job.timer = this.schedule(() => this.checkTime(), budget);
      void Promise.resolve()
        .then(() => {
          if (job.controller.signal.aborted) return null;
          return provider(evidence, job.controller.signal);
        })
        .then(
          (index) => complete(index, "invalid_move"),
          () => complete(null, "provider_failure"),
        );
    }, 0);
  }
  private frame(r: Room, event: ReplayFrame["event"], cellIndex?: number) {
    if (r.saveStatus !== "recording") return;
    const s = this.roomSnapshot(r);
    const previous = r.frames.at(-1);
    if (
      event === "presence" &&
      previous?.state.phase === s.phase &&
      s.players.every((p, i) => {
        const old = previous.state.players[i];
        return (
          old?.connected === p.connected &&
          old.reservedUntil ===
            (p.reservedUntil === null ? null : p.reservedUntil - r.startedAt)
        );
      })
    )
      return;
    // Replay identities are seat labels, never account IDs or game-session credentials.
    const label = (id: string | null) =>
      id === null ? null : String(r.players.findIndex((p) => p.id === id));
    r.frames.push({
      sequence: r.frames.length,
      elapsedMs: this.now() - r.startedAt,
      event,
      ...(cellIndex === undefined ? {} : { cellIndex }),
      state: {
        players: s.players.map((p, i) => ({
          ...p,
          id: String(i),
          reservedUntil:
            p.reservedUntil === null ? null : p.reservedUntil - r.startedAt,
        })),
        cells: s.cells,
        activePlayer: label(s.activePlayer),
        deadline: s.deadline === null ? null : s.deadline - r.startedAt,
        winner: label(s.winner),
        phase: s.phase,
        resultReason: s.resultReason,
      },
    });
  }
  private finish(
    r: Room,
    winner: string,
    reason: "completed" | "forfeit",
    cellIndex?: number,
  ) {
    if (r.phase !== "active") return;
    this.cancelBot(r);
    r.phase = "finished";
    r.winner = winner;
    r.resultReason = reason;
    r.deadline = null;
    r.activePlayer = null;
    r.turnId = randomUUID();
    r.message =
      reason === "forfeit"
        ? "An opponent left. The remaining player wins by forfeit."
        : "All 11 bombs found.";
    this.frame(r, reason === "forfeit" ? "forfeit" : "reveal", cellIndex);
    this.arm(r);
    if (r.saveStatus === "recording") {
      const [a, b] = r.players as [Player, Player];
      const record: MatchRecord = {
        matchId: r.matchId,
        playerOneId: a.userId!,
        playerTwoId: b.userId!,
        playerOneName: a.nickname,
        playerTwoName: b.nickname,
        playerOneScore: a.score,
        playerTwoScore: b.score,
        winnerSeat: winner === a.id ? 0 : 1,
        startedAt: new Date(r.startedAt),
        finishedAt: new Date(this.now()),
        reason,
        replay: { version: 1, frames: r.frames },
      };
      r.frames = [];
      r.saveStatus = "pending";
      this.pending.set(record.matchId, {
        record,
        failed: false,
        saving: false,
      });
      // A microtask starts I/O only after the complete synchronous transition.
      void Promise.resolve().then(() => this.save(record.matchId));
    }
  }
  private async save(matchId: string) {
    const entry = this.pending.get(matchId);
    if (!entry || entry.saving || this.disposed) return;
    entry.saving = true;
    try {
      if (!this.writer) throw new Error("Result storage is not configured.");
      await this.writer(structuredClone(entry.record));
      if (this.disposed) return;
      this.pending.delete(matchId);
      this.updateSaveStatus(matchId, "saved");
    } catch {
      if (this.disposed) return;
      entry.failed = true;
      entry.saving = false;
      this.log(
        `[game history] save failed for match ${matchId}; retrying in 5 seconds`,
      );
      this.updateSaveStatus(matchId, "failed");
      entry.timer = this.schedule(() => {
        void this.save(matchId);
      }, 5000);
    }
  }
  private updateSaveStatus(matchId: string, status: SaveStatus) {
    const r = [...this.rooms.values()].find((r) => r.matchId === matchId);
    if (r) r.saveStatus = status;
    this.publish(r);
  }
  rematch(actor: Actor, roomId: string, matchId: string) {
    this.checkTime();
    const r = this.room(roomId),
      p = this.player(actor, r);
    if (
      r.phase !== "finished" ||
      r.resultReason !== "completed" ||
      r.matchId !== matchId ||
      r.players.some((p) => !p.seated)
    )
      this.fail("This result is no longer available for a rematch.");
    if (r.mode === "bot") {
      this.reserveBotGame();
      r.votes.add(r.players.find((player) => player.bot)!.id);
    }
    r.votes.add(p.id);
    this.maybeBegin(r);
    this.publish(r);
    return this.snapshot(roomId, actor);
  }
  leave(actor: Actor, roomId: string) {
    this.checkTime();
    const r = this.rooms.get(roomId);
    if (!r) return { success: true };
    const p = r.players.find((p) => p.key === keyOf(actor) && p.seated);
    if (!p) return { success: true };
    if (r.phase === "active")
      this.finish(r, this.opponent(r, p.id).id, "forfeit");
    this.release(r, p);
    return { success: true };
  }
  private release(r: Room, p: Player) {
    p.seated = false;
    if (r.mode === "bot" && !p.bot) {
      this.cancelBot(r);
      for (const bot of r.players.filter((player) => player.bot))
        bot.seated = false;
    }
    p.reservedUntil = null;
    if (this.membership.get(p.key) === r.id) this.membership.delete(p.key);
    if (r.phase === "lobby") r.players = r.players.filter((p) => p.seated);
    if (!r.players.some((p) => p.seated)) {
      this.cancelTimer(r.timer);
      r.phase = "closed";
      r.message = "This room has closed.";
      r.deadline = null;
      this.publish(r);
      this.rooms.delete(r.id);
      // Close all room streams; a final snapshot is emitted by gameStream before it ends.
      for (const [id, presence] of this.presence) {
        for (const [streamId, stream] of presence.streams)
          if (stream.roomId === r.id) {
            presence.streams.delete(streamId);
            stream.close();
          }
        if (!presence.streams.size) {
          this.cancelTimer(presence.timer);
          this.presence.delete(id);
        } else this.armPresence(presence);
      }
      this.listeners.delete(r.id);
      this.publish();
    } else {
      this.arm(r);
      this.publish(r);
    }
  }
  private clearMatch(r: Room, manualStart: boolean, message: string) {
    this.cancelBot(r);
    this.cancelTimer(r.timer);
    r.matchId = randomUUID();
    r.turnId = randomUUID();
    r.phase = "lobby";
    r.bombs.clear();
    r.cells = covered();
    r.activePlayer = null;
    r.deadline = null;
    r.winner = null;
    r.votes.clear();
    r.resultReason = null;
    r.frames = [];
    r.saveStatus = "unrecorded";
    r.manualStart = manualStart;
    r.message = message;
    r.players.forEach((p) => {
      p.score = 0;
    });
  }
  reset(roomId: string) {
    this.checkTime();
    const r = this.room(roomId);
    this.clearMatch(
      r,
      true,
      "Operator reset. Waiting for the operator to start.",
    );
    for (const p of [...r.players])
      if (!p.seated || !this.connected(p.key, r.id)) this.release(r, p);
    if (!this.rooms.has(roomId)) return this.roomSnapshot(r);
    this.arm(r);
    this.publish(r);
    return this.snapshot(roomId);
  }
  start(roomId: string) {
    this.checkTime();
    const r = this.room(roomId);
    if (r.phase !== "lobby" || !r.manualStart)
      this.fail("Start is available only after an operator reset.");
    if (
      r.players.length !== 2 ||
      !r.players.every((p) => p.seated && this.connected(p.key, r.id))
    )
      this.fail("Two connected players are required.");
    if (r.mode === "bot") this.reserveBotGame();
    this.begin(r);
    this.publish(r);
    return this.snapshot(roomId);
  }
  dispose() {
    this.disposed = true;
    this.cancelTimer(this.queueTimer);
    this.cancelTimer(this.botQuotaTimer);
    for (const r of this.rooms.values()) {
      this.cancelBot(r);
      this.cancelTimer(r.timer);
    }
    for (const p of this.pending.values()) this.cancelTimer(p.timer);
    const streams = [...this.presence.values()].flatMap((p) => {
      this.cancelTimer(p.timer);
      return [...p.streams.values()];
    });
    this.presence.clear();
    this.rooms.clear();
    this.membership.clear();
    this.queue.clear();
    this.pending.clear();
    this.listeners.clear();
    streams.forEach((s) => s.close());
  }
}

const globalGame = globalThis as typeof globalThis & {
  findMyMinesGame?: GameService;
};
const game = (globalGame.findMyMinesGame ??= new GameService());
// Never change the prototype of an older authority: its live callbacks must keep working.
if (game.runtimeVersion === 3)
  Object.setPrototypeOf(game, GameService.prototype);
export function getGame() {
  if (game.runtimeVersion !== 3)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Game service updated. Ask the server owner to restart the application when existing games have ended.",
    });
  return game;
}
