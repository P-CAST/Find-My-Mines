import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { gameStream } from "~/server/game/stream";
import { getMessages, messageInput } from "~/server/messages/service";

const messageProcedure = publicProcedure.use(({ ctx, next }) =>
  next({
    ctx: {
      ...ctx,
      messages: getMessages(),
      actor: {
        sessionId: ctx.gameSession.id,
        userId: ctx.session?.user.id ?? null,
        userName: ctx.session?.user.name ?? null,
      },
    },
  }),
);

export const messagesRouter = createTRPCRouter({
  send: messageProcedure
    .input(messageInput)
    .mutation(({ ctx, input }) => ctx.messages.send(ctx.actor, input)),
  onBoard: messageProcedure.subscription(({ ctx, signal }) =>
    gameStream({
      snapshot: () => ctx.messages.snapshot(ctx.actor),
      listen: (listener) => ctx.messages.listen(listener),
      signal,
    }),
  ),
});
