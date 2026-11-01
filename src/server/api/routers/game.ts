import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { env } from "~/env";
import { createAnalysisService } from "~/server/game/analysis";
import {
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from "~/server/api/trpc";
import { getGame, type Actor } from "~/server/game/service";
import { gameStream } from "~/server/game/stream";
import { operatorLogin, operatorLogout } from "~/server/game/session";
import {
  history,
  profile,
  replay,
  saveResult,
  analysisSource,
  readAnalysis,
  saveAnalysis,
  setVisibility,
} from "~/server/game/history";

const analysisService = createAnalysisService(
  { analysisSource, readAnalysis, saveAnalysis },
  { apiKey: env.OPENAI_API_KEY, model: env.OPENAI_ANALYSIS_MODEL },
);

const gameProcedure = publicProcedure.use(({ ctx, next }) => {
  const game = getGame();
  game.setResultWriter(saveResult);
  const actor: Actor = {
    sessionId: ctx.gameSession.id,
    userId: ctx.session?.user.id ?? null,
    authSessionId: ctx.session?.session.id,
  };
  return next({ ctx: { ...ctx, game, actor } });
});
const operatorProcedure = gameProcedure.use(({ ctx, next }) => {
  if (!ctx.gameSession.operator)
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Operator login required.",
    });
  return next();
});
const roomInput = z.object({ roomId: z.string().uuid() });
const nickname = z
  .string()
  .trim()
  .min(1)
  .max(24)
  .refine((value) => !/[\p{C}]/u.test(value), "Use visible characters.");
export const gameRouter = createTRPCRouter({
  analysis: publicProcedure
    .input(z.object({ matchId: z.string().uuid() }))
    .query(({ ctx, input }) =>
      analysisService.read(ctx.session?.user.id ?? null, input.matchId),
    ),
  generateAnalysis: protectedProcedure
    .input(z.object({ matchId: z.string().uuid() }))
    .mutation(({ ctx, input }) =>
      analysisService.generate(ctx.session.user.id, input.matchId),
    ),
  session: gameProcedure.query(({ ctx }) => ({
    id: ctx.gameSession.id,
    operator: ctx.gameSession.operator,
    account: !!ctx.actor.userId,
    serverNow: Date.now(),
    instanceId: ctx.game.instanceId,
  })),
  create: gameProcedure
    .input(z.object({ nickname, visibility: z.enum(["public", "unlisted"]) }))
    .mutation(({ ctx, input }) =>
      ctx.game.create(ctx.actor, input.nickname, input.visibility),
    ),
  join: gameProcedure
    .input(roomInput.extend({ nickname }))
    .mutation(({ ctx, input }) =>
      ctx.game.join(ctx.actor, input.roomId, input.nickname),
    ),
  leave: gameProcedure
    .input(roomInput)
    .mutation(({ ctx, input }) => ctx.game.leave(ctx.actor, input.roomId)),
  queueJoin: gameProcedure
    .input(z.object({ nickname }))
    .mutation(({ ctx, input }) =>
      ctx.game.queueJoin(ctx.actor, input.nickname),
    ),
  queueCancel: gameProcedure.mutation(({ ctx }) =>
    ctx.game.queueCancel(ctx.actor),
  ),
  reveal: gameProcedure
    .input(
      roomInput.extend({
        matchId: z.string().uuid(),
        turnId: z.string().uuid(),
        cellIndex: z.number().int().min(0).max(35),
      }),
    )
    .mutation(({ ctx, input }) => ctx.game.reveal(ctx.actor, input)),
  rematch: gameProcedure
    .input(roomInput.extend({ matchId: z.string().uuid() }))
    .mutation(({ ctx, input }) =>
      ctx.game.rematch(ctx.actor, input.roomId, input.matchId),
    ),
  heartbeat: gameProcedure
    .input(z.object({ roomId: z.string().uuid().optional() }))
    .mutation(({ ctx, input }) =>
      ctx.game.heartbeat(ctx.actor, input.roomId ?? null),
    ),
  onLobby: gameProcedure.subscription(({ ctx, signal }) =>
    gameStream({
      snapshot: () => ctx.game.lobby(ctx.actor),
      listen: (listener) => ctx.game.listen("lobby", listener),
      connect: (close) => ctx.game.connect(ctx.actor, null, close),
      signal,
    }),
  ),
  onState: gameProcedure
    .input(roomInput)
    .subscription(({ ctx, input, signal }) =>
      gameStream({
        snapshot: () => ctx.game.snapshot(input.roomId, ctx.actor),
        isTerminal: (snapshot) => snapshot.phase === "closed",
        listen: (listener) => ctx.game.listen(input.roomId, listener),
        connect: (close) => ctx.game.connect(ctx.actor, input.roomId, close),
        signal,
      }),
    ),
  onClients: operatorProcedure.subscription(({ ctx, signal }) =>
    gameStream({
      snapshot: () => ctx.game.clients(),
      listen: (listener) => ctx.game.listen("operator", listener),
      signal,
    }),
  ),
  // Observing a room as operator must not establish player presence.
  onRoom: operatorProcedure
    .input(roomInput)
    .subscription(({ ctx, input, signal }) =>
      gameStream({
        snapshot: () => ctx.game.snapshot(input.roomId),
        isTerminal: (snapshot) => snapshot.phase === "closed",
        listen: (listener) => ctx.game.listen(input.roomId, listener),
        signal,
      }),
    ),
  reset: operatorProcedure
    .input(roomInput)
    .mutation(({ ctx, input }) => ctx.game.reset(input.roomId)),
  start: operatorProcedure
    .input(roomInput)
    .mutation(({ ctx, input }) => ctx.game.start(input.roomId)),
  login: gameProcedure
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
  logout: gameProcedure.mutation(({ ctx }) => {
    operatorLogout(ctx.responseHeaders, ctx.gameSession.secure);
    return { success: true };
  }),
  profile: protectedProcedure.query(({ ctx }) => profile(ctx.session.user.id)),
  setVisibility: protectedProcedure
    .input(z.object({ historyPublic: z.boolean() }))
    .mutation(({ ctx, input }) =>
      setVisibility(ctx.session.user.id, input.historyPublic),
    ),
  history: publicProcedure
    .input(
      z.object({
        publicId: z.string().uuid().optional(),
        cursor: z
          .object({ finishedAt: z.date(), matchId: z.string().uuid() })
          .optional(),
      }),
    )
    .query(({ ctx, input }) => history(ctx.session?.user.id ?? null, input)),
  replay: publicProcedure
    .input(z.object({ matchId: z.string().uuid() }))
    .query(({ ctx, input }) =>
      replay(ctx.session?.user.id ?? null, input.matchId),
    ),
});
