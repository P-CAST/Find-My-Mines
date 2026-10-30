import { createHash, randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

export const messageInput = z
  .object({
    text: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine(
        (value) => !/[\p{C}]/u.test(value.replace(/[\n\r\t]/g, "")),
        "Use visible text and line breaks.",
      ),
  })
  .strict();
export type MessageActor = {
  sessionId: string;
  userId: string | null;
  userName?: string | null;
};
export type BoardMessage = {
  id: string;
  nickname: string;
  text: string;
  sentAt: number;
  account: boolean;
  own: boolean;
};
export type BoardSnapshot = {
  instanceId: string;
  revision: number;
  messages: BoardMessage[];
};
const actorKey = (actor: MessageActor) =>
  actor.userId ? `account:${actor.userId}` : `guest:${actor.sessionId}`;
// A stable public label, never an authorization credential or raw session ID.
const anonymousName = (author: string) =>
  `Anonymous ${100_000 + (createHash("sha256").update(author).digest().readUInt32BE(0) % 900_000)}`;

/** Independent of game rooms, presence, timers, and recordings. */
export class MessageService {
  readonly runtimeVersion = 1;
  readonly instanceId = randomUUID();
  private revision = 0;
  private messages: (Omit<BoardMessage, "own"> & { author: string })[] = [];
  private listeners = new Set<() => void>();
  private attempts = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  send(actor: MessageActor, input: z.input<typeof messageInput>) {
    const { text } = messageInput.parse(input);
    const now = this.now();
    // Expire inactive identities as well as timestamps outside the rolling window.
    for (const [key, times] of this.attempts) {
      const recent = times.filter((time) => time > now - 60_000);
      if (recent.length) this.attempts.set(key, recent);
      else this.attempts.delete(key);
    }
    const key = actorKey(actor);
    const accountName = (actor.userName ?? "").replace(/[\p{C}]/gu, "").trim();
    const nickname = actor.userId
      ? accountName.length > 0
        ? accountName
        : "Account"
      : anonymousName(key);
    const times = this.attempts.get(key) ?? [];
    if (times.length >= 10 || (times.length && now - times.at(-1)! < 2000))
      throw new TRPCError({
        code: "TOO_MANY_REQUESTS",
        message:
          "Wait two seconds between messages; send at most ten per minute.",
      });
    times.push(now);
    this.attempts.set(key, times);
    const message = {
      id: randomUUID(),
      nickname,
      text,
      sentAt: now,
      account: !!actor.userId,
      author: key,
    };
    this.messages.push(message);
    if (this.messages.length > 100) this.messages.shift();
    this.revision++;
    this.listeners.forEach((listener) => listener());
    return { id: message.id };
  }

  snapshot(actor: MessageActor): BoardSnapshot {
    const key = actorKey(actor);
    return {
      instanceId: this.instanceId,
      revision: this.revision,
      messages: this.messages.map(({ author, ...message }) => ({
        ...message,
        // Also relabel guest messages retained from the previous UI under HMR.
        nickname: message.account ? message.nickname : anonymousName(author),
        own: author === key,
      })),
    };
  }

  listen(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

const globalMessages = globalThis as typeof globalThis & {
  findMyMinesMessages?: MessageService;
};
const messages = (globalMessages.findMyMinesMessages ??= new MessageService());
if (messages.runtimeVersion === 1)
  Object.setPrototypeOf(messages, MessageService.prototype);
export function getMessages() {
  if (messages.runtimeVersion !== 1)
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message:
        "Messaging service updated. Ask the server owner to restart the application when existing games have ended.",
    });
  return messages;
}
