import { z } from "zod";
import { eq, and, gt } from "drizzle-orm";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { friendStore } from "../../friends";
import { social } from "../../friends/service";
import { getGame } from "../../game/service";
import { gameStream } from "../../game/stream";
import { session } from "../../db/schema";

export const friendsRouter = createTRPCRouter({
  search: protectedProcedure
    .input(
      z.object({
        query: z.string().trim().min(2).max(100),
        cursor: z.string().uuid().optional(),
      }),
    )
    .query(({ ctx, input }) => {
      social.limit(ctx.session.user.id, "search");
      return friendStore.search(ctx.session.user.id, input.query, input.cursor);
    }),
  list: protectedProcedure
    .input(
      z.object({
        kind: z.enum(["friends", "incoming", "outgoing"]),
        cursor: z.string().uuid().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const page = await friendStore.list(
        ctx.session.user.id,
        input.kind,
        input.cursor,
      );
      return {
        ...page,
        items: page.items.map(({ userId, ...item }) => ({
          ...item,
          online: input.kind === "friends" && social.online(userId),
        })),
      };
    }),
  incomingCount: protectedProcedure.query(({ ctx }) =>
    friendStore.incomingCount(ctx.session.user.id),
  ),
  change: protectedProcedure
    .input(
      z.object({
        publicId: z.string().uuid(),
        action: z.enum(["send", "accept", "decline", "cancel", "remove"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const viewer = ctx.session.user.id,
        other = await friendStore.target(input.publicId);
      return social.serial(viewer, other.userId, async () => {
        const game = getGame();
        const before = await friendStore.relationship(viewer, other.userId);
        if (input.action === "send" && !before) {
          social.limit(viewer, "request");
          social.checkCooldown(viewer, other.userId, "request");
        }
        const status = await friendStore.change(
          viewer,
          other.userId,
          input.action,
        );
        if ((before?.status ?? "none") === status) return { status };
        if (["decline", "cancel", "remove"].includes(input.action))
          social.cool(viewer, other.userId, "request");
        social.relationship(viewer, other.userId, status === "accepted");
        if (status !== "accepted")
          game.cancelFriendInvitations(viewer, other.userId);
        return { status };
      });
    }),
  heartbeat: protectedProcedure.mutation(({ ctx }) => {
    social.heartbeat(ctx.session.user.id, ctx.session.session.id);
    return social.snapshot();
  }),
  onUpdate: protectedProcedure.subscription(async function* ({ ctx, signal }) {
    const game = getGame();
    const userId = ctx.session.user.id,
      sessionId = ctx.session.session.id;
    // Attach listeners before asynchronous initialization or the initial snapshot.
    const unlisten = social.listen(userId, () => undefined);
    try {
      let ids: string[], revision: number;
      do {
        revision = social.snapshot().revision;
        ids = await friendStore.friendIds(userId);
        // A relationship may commit while the initial query is in flight.
        // Do not overwrite the live presence audience with that older snapshot.
      } while (!signal?.aborted && revision !== social.snapshot().revision);
      social.watch(userId, ids);
      if (signal?.aborted) return;
      // Every lease interval re-check the persisted session, including external revocation.
      let validating = false;
      const validate = setInterval(() => {
        if (validating) return;
        validating = true;
        void ctx.db
          .select({ id: session.id })
          .from(session)
          .where(
            and(
              eq(session.id, sessionId),
              eq(session.userId, userId),
              gt(session.expiresAt, new Date()),
            ),
          )
          .then((rows) => {
            if (!rows.length) social.disconnectSession(sessionId);
          })
          .catch(() => social.disconnectSession(sessionId))
          .finally(() => {
            validating = false;
          });
      }, 10_000);
      validate.unref();
      try {
        yield* gameStream({
          snapshot: () => social.snapshot(),
          listen: (fn) => {
            const a = social.listen(userId, fn),
              b = game.listen(`social:${userId}`, () => social.notify(userId));
            return () => {
              a();
              b();
            };
          },
          connect: (close) =>
            social.connect(userId, sessionId, close).disconnect,
          signal,
        });
      } finally {
        clearInterval(validate);
      }
    } finally {
      unlisten();
    }
  }),
});
