import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "~/server/api/trpc";
import { game } from "~/server/game/service";
import { gameStream } from "~/server/game/stream";
import { operatorLogin, operatorLogout } from "~/server/game/session";

const operatorProcedure = publicProcedure.use(({ ctx, next }) => {
  if (!ctx.gameSession.operator)
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Operator login required.",
    });
  return next();
});
export const gameRouter = createTRPCRouter({
  session: publicProcedure.query(({ ctx }) => ({
    id: ctx.gameSession.id,
    operator: ctx.gameSession.operator,
    serverNow: Date.now(),
    instanceId: game.instanceId,
  })),
  join: publicProcedure
    .input(
      z.object({
        nickname: z
          .string()
          .trim()
          .min(1)
          .max(24)
          .refine(
            (value) => !/[\p{C}]/u.test(value),
            "Use visible characters.",
          ),
      }),
    )
    .mutation(({ ctx, input }) =>
      game.join(ctx.gameSession.id, input.nickname),
    ),
  reveal: publicProcedure
    .input(
      z.object({
        matchId: z.string().uuid(),
        turnId: z.string().uuid(),
        cellIndex: z.number().int().min(0).max(35),
      }),
    )
    .mutation(({ ctx, input }) => game.reveal(ctx.gameSession.id, input)),
  rematch: publicProcedure
    .input(z.object({ matchId: z.string().uuid() }))
    .mutation(({ ctx, input }) =>
      game.rematch(ctx.gameSession.id, input.matchId),
    ),
  heartbeat: publicProcedure.mutation(({ ctx }) =>
    game.heartbeat(ctx.gameSession.id),
  ),
  onState: publicProcedure.subscription(({ ctx, signal }) =>
    gameStream(() => game.snapshot(), signal, ctx.gameSession.id),
  ),
  onClients: operatorProcedure.subscription(({ signal }) =>
    gameStream(() => game.clients(), signal),
  ),
  reset: operatorProcedure.mutation(() => game.reset()),
  start: operatorProcedure.mutation(() => game.start()),
  login: publicProcedure
    .input(z.object({ password: z.string().min(1).max(256) }))
    .mutation(({ ctx, input }) => {
      operatorLogin(
        ctx.gameSession.id,
        input.password,
        ctx.responseHeaders,
        ctx.gameSession.secure,
      );
      return { success: true };
    }),
  logout: publicProcedure.mutation(({ ctx }) => {
    operatorLogout(ctx.responseHeaders, ctx.gameSession.secure);
    return { success: true };
  }),
});
