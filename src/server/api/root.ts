import { friendsRouter } from "~/server/api/routers/friends";
import { gameRouter } from "~/server/api/routers/game";
import { postRouter } from "~/server/api/routers/post";
import { messagesRouter } from "~/server/api/routers/messages";
import { createCallerFactory, createTRPCRouter } from "~/server/api/trpc";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const gameApiRouter = createTRPCRouter({
  friends: friendsRouter,
  post: postRouter,
  game: gameRouter,
});
export const messagesApiRouter = createTRPCRouter({ messages: messagesRouter });

// Combined type/caller; HTTP routes expose only their respective procedure sets.
export const appRouter = createTRPCRouter({
  friends: friendsRouter,
  post: postRouter,
  game: gameRouter,
  messages: messagesRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;

/**
 * Create a server-side caller for the tRPC API.
 * @example
 * const trpc = createCaller(createContext);
 * const res = await trpc.post.all();
 *       ^? Post[]
 */
export const createCaller = createCallerFactory(appRouter);
