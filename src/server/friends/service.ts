import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { pairKey } from "./store";

type Lease = {
  userId: string;
  sessionId: string;
  expires: number;
  close: () => void;
  timer: ReturnType<typeof setTimeout>;
};
/** Social leases never connect to GameService or renew its presence. */
export class SocialService {
  readonly instanceId = randomUUID();
  private revision = 0;
  private leases = new Map<string, Lease>();
  private listeners = new Map<string, Set<() => void>>();
  private friends = new Map<string, Set<string>>();
  private attempts = new Map<string, number[]>();
  private cooldowns = new Map<string, number>();
  private cleanupTimer?: ReturnType<typeof setTimeout>;
  private locks = new Map<string, Promise<unknown>>();
  constructor(private readonly now = Date.now) {}
  async serial<T>(a: string, b: string, work: () => Promise<T>): Promise<T> {
    const key = pairKey(a, b);
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.locks.set(key, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(key) === next) this.locks.delete(key);
    }
  }
  private cleanup() {
    for (const [key, times] of this.attempts) {
      const recent = times.filter((t) => t + 60_000 > this.now());
      if (recent.length) this.attempts.set(key, recent);
      else this.attempts.delete(key);
    }
    for (const [key, expiry] of this.cooldowns)
      if (expiry <= this.now()) this.cooldowns.delete(key);
  }
  private armCleanup() {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = undefined;
      this.cleanup();
      if (this.attempts.size || this.cooldowns.size) this.armCleanup();
    }, 60_000);
    this.cleanupTimer.unref();
  }
  limit(userId: string, kind: "search" | "request" | "invite") {
    this.cleanup();
    const key = `${kind}:${userId}`,
      times = this.attempts.get(key) ?? [];
    if (times.length >= { search: 30, request: 10, invite: 5 }[kind])
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "Too many attempts. Try again in a minute.",
      });
    this.attempts.set(key, [...times, this.now()]);
    this.armCleanup();
  }
  cool(a: string, b: string, kind: "request" | "invite") {
    this.cooldowns.set(`${kind}:${pairKey(a, b)}`, this.now() + 60_000);
    this.armCleanup();
  }
  checkCooldown(a: string, b: string, kind: "request" | "invite") {
    for (const [key, expiry] of this.cooldowns)
      if (expiry <= this.now()) this.cooldowns.delete(key);
    if (this.cooldowns.has(`${kind}:${pairKey(a, b)}`))
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message: "Wait a minute before trying this player again.",
      });
  }
  online(userId: string) {
    return [...this.leases.values()].some(
      (l) => l.userId === userId && l.expires > this.now(),
    );
  }
  watch(userId: string, friends: string[]) {
    this.friends.set(userId, new Set(friends));
  }
  relationship(a: string, b: string, accepted: boolean) {
    for (const [one, two] of [
      [a, b],
      [b, a],
    ] as const) {
      if (accepted) this.friends.get(one)?.add(two);
      else this.friends.get(one)?.delete(two);
    }
    this.notify(a);
    this.notify(b);
  }
  notify(userId: string) {
    this.revision++;
    this.listeners.get(userId)?.forEach((fn) => fn());
  }
  private presenceChanged(userId: string) {
    this.notify(userId);
    for (const [viewer, friends] of this.friends)
      if (friends.has(userId)) this.notify(viewer);
  }
  snapshot() {
    return { instanceId: this.instanceId, revision: this.revision };
  }
  listen(userId: string, fn: () => void) {
    const listeners = this.listeners.get(userId) ?? new Set();
    listeners.add(fn);
    this.listeners.set(userId, listeners);
    return () => {
      listeners.delete(fn);
      if (!listeners.size) {
        this.listeners.delete(userId);
        this.friends.delete(userId);
      }
    };
  }
  connect(userId: string, sessionId: string, close: () => void) {
    const wasOnline = this.online(userId),
      id = randomUUID();
    const remove = () => {
      const lease = this.leases.get(id);
      if (!lease) return;
      clearTimeout(lease.timer);
      this.leases.delete(id);
      if (!this.online(userId)) this.presenceChanged(userId);
    };
    const expire = () => {
      remove();
      close();
    };
    const timer = setTimeout(expire, 15_000);
    timer.unref();
    this.leases.set(id, {
      userId,
      sessionId,
      close,
      expires: this.now() + 15_000,
      timer,
    });
    if (!wasOnline) this.presenceChanged(userId);
    return { id, disconnect: remove };
  }
  heartbeat(userId: string, sessionId: string) {
    for (const [id, lease] of this.leases)
      if (lease.userId === userId && lease.sessionId === sessionId) {
        if (lease.expires <= this.now()) {
          clearTimeout(lease.timer);
          this.leases.delete(id);
          lease.close();
          this.presenceChanged(userId);
          continue;
        }
        lease.expires = this.now() + 15_000;
        lease.timer.refresh();
      }
  }
  disconnectSession(sessionId: string) {
    for (const [id, lease] of this.leases)
      if (lease.sessionId === sessionId) {
        clearTimeout(lease.timer);
        this.leases.delete(id);
        lease.close();
        this.presenceChanged(lease.userId);
      }
  }
  dispose() {
    clearTimeout(this.cleanupTimer);
    for (const lease of this.leases.values()) {
      clearTimeout(lease.timer);
      lease.close();
    }
    this.leases.clear();
    this.listeners.clear();
    this.friends.clear();
    this.attempts.clear();
    this.cooldowns.clear();
  }
}
const globalSocial = globalThis as typeof globalThis & {
  findMyMinesSocial?: SocialService;
};
export const social = (globalSocial.findMyMinesSocial ??= new SocialService());
