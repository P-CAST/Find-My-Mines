import { ratingStore } from "~/server/game/ratings";
import { achievementStore } from "~/server/game/achievements";
import { friendStore } from "~/server/friends";
import { social } from "~/server/friends/service";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { env } from "~/env";
import { createBotProvider } from "~/server/game/bot";
import { createAnalysisService } from "~/server/game/analysis";
import {
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from "~/server/api/trpc";
import { getGame, type Actor } from "~/server/game/service";
import { gameStream } from "~/server/game/stream";
import {
  operatorLogin,
  operatorLogout,
  nicknameInput,
  setGuestName,
  playerName,
} from "~/server/game/session";
import {
  history,
  profile,
  replay,
  saveCompletion,
  analysisSource,
  readAnalysis,
  saveAnalysis,
  setVisibility,
} from "~/server/game/history";

const botProvider = createBotProvider({
  apiKey: env.OPENAI_API_KEY,
  model: env.OPENAI_BOT_MODEL,
});

const analysisService = createAnalysisService(
  { analysisSource, readAnalysis, saveAnalysis },
  { apiKey: env.OPENAI_API_KEY, model: env.OPENAI_ANALYSIS_MODEL },
);

const gameProcedure = publicProcedure.use(({ ctx, next }) => {
  const game = getGame();
  game.setCompletionWriter(saveCompletion);
  game.setBotProvider(botProvider);
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
export const gameRouter = createTRPCRouter({
  leaderboard: publicProcedure
    .input(z.object({ page: z.number().int().min(0).max(1000000).default(0) }))
    .query(({ input }) => ratingStore.leaderboard(input.page)),
  rating: protectedProcedure.query(({ ctx }) =>
    ratingStore.own(ctx.session.user.id),
  ),
  matchRating: protectedProcedure
    .input(z.object({ matchId: z.string().uuid() }))
    .query(({ ctx, input }) =>
      ratingStore.match(ctx.session.user.id, input.matchId),
    ),
  achievements: protectedProcedure.query(({ ctx }) =>
    achievementStore.own(ctx.session.user.id),
  ),
  publicAchievements: publicProcedure
    .input(z.object({ publicId: z.string().uuid() }))
    .query(({ input }) => achievementStore.publicCollection(input.publicId)),
  setAchievementVisibility: protectedProcedure
    .input(z.object({ achievementsPublic: z.boolean() }))
    .mutation(({ ctx, input }) =>
      achievementStore.setVisibility(
        ctx.session.user.id,
        input.achievementsPublic,
      ),
    ),
  invitations: protectedProcedure.query(({ ctx }) =>
    getGame().invitationsFor(ctx.session.user.id),
  ),
  inviteFriend: protectedProcedure
    .input(z.object({ publicId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const fromId = ctx.session.user.id,
        to = await friendStore.target(input.publicId);
      return social.serial(fromId, to.userId, async () => {
        if (
          (await friendStore.relationship(fromId, to.userId))?.status !==
          "accepted"
        )
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Only friends can invite each other.",
          });
        const game = getGame();
        if (
          !game
            .invitationsFor(fromId)
            .some(
              (i) =>
                !i.roomId && !i.incoming && i.other.publicId === to.publicId,
            )
        ) {
          social.limit(fromId, "invite");
          social.checkCooldown(fromId, to.userId, "invite");
        }
        const from = await profile(fromId);
        if (!social.online(fromId) || !social.online(to.userId))
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Both friends must be online.",
          });
        return game.inviteFriend(
          {
            userId: fromId,
            publicId: from.publicId,
            name: ctx.session.user.name,
          },
          to,
        );
      });
    }),
  respondInvitation: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        action: z.enum(["accept", "decline", "cancel"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const viewer = ctx.session.user.id,
        game = getGame();
      const pair = game.invitationPair(viewer, input.id);
      return social.serial(pair.from, pair.to, async () => {
        if (input.action !== "accept") {
          game.dismissFriendInvitation(viewer, input.id, input.action);
          social.cool(pair.from, pair.to, "invite");
          return { roomId: null };
        }
        if (
          (await friendStore.relationship(pair.from, pair.to))?.status !==
          "accepted"
        )
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "This friendship is no longer available.",
          });
        if (!social.online(pair.from) || !social.online(pair.to))
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Both friends must be online.",
          });
        return game.acceptFriendInvitation(viewer, input.id);
      });
    }),
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
    nickname:
      ctx.session?.user.name != null
        ? playerName(ctx.session.user.name, null)
        : ctx.gameSession.guestName,
    serverNow: Date.now(),
    instanceId: ctx.game.instanceId,
  })),
  setGuestName: gameProcedure
    .input(z.object({ nickname: nicknameInput }).strict())
    .mutation(({ ctx, input }) => {
      if (ctx.session)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Signed-in players use their account name.",
        });
      return {
        nickname: setGuestName(
          ctx.gameSession,
          input.nickname,
          ctx.responseHeaders,
        ),
      };
    }),
  create: gameProcedure
    .input(z.object({ visibility: z.enum(["public", "unlisted"]) }).strict())
    .mutation(({ ctx, input }) =>
      ctx.game.create(
        ctx.actor,
        playerName(ctx.session?.user.name, ctx.gameSession.guestName),
        input.visibility,
      ),
    ),
  createBot: gameProcedure.mutation(({ ctx }) =>
    ctx.game.createBot(
      ctx.actor,
      playerName(ctx.session?.user.name, ctx.gameSession.guestName),
    ),
  ),
  join: gameProcedure
    .input(roomInput.strict())
    .mutation(({ ctx, input }) =>
      ctx.game.join(
        ctx.actor,
        input.roomId,
        playerName(ctx.session?.user.name, ctx.gameSession.guestName),
      ),
    ),
  leave: gameProcedure
    .input(roomInput)
    .mutation(({ ctx, input }) => ctx.game.leave(ctx.actor, input.roomId)),
  queueJoin: gameProcedure.mutation(({ ctx }) =>
    ctx.game.queueJoin(
      ctx.actor,
      playerName(ctx.session?.user.name, ctx.gameSession.guestName),
    ),
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
