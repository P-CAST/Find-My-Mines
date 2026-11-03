import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { db } from "~/server/db";
import { gameProfiles, gameResults, user } from "~/server/db/schema";

type Database = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
export function createRatingStore(database: Database) {
  const ranked = database
    .select({
      publicId: gameProfiles.publicId,
      name: user.name,
      rating: gameProfiles.rating,
      games: gameProfiles.ratedGames,
      wins: gameProfiles.ratedWins,
      losses: gameProfiles.ratedLosses,
      rank: sql<number>`rank() over (order by ${gameProfiles.rating} desc)`
        .mapWith(Number)
        .as("rank"),
    })
    .from(gameProfiles)
    .innerJoin(user, eq(user.id, gameProfiles.userId))
    .where(gt(gameProfiles.ratedGames, 0))
    .as("ranked");

  async function leaderboard(page: number) {
    const rows = await database
      .select()
      .from(ranked)
      .orderBy(desc(ranked.rating), asc(ranked.publicId))
      .limit(51)
      .offset(page * 50);
    return { items: rows.slice(0, 50), hasNextPage: rows.length > 50 };
  }
  async function own(userId: string) {
    const [profile] = await database
      .select()
      .from(gameProfiles)
      .where(eq(gameProfiles.userId, userId));
    if (!profile?.ratedGames)
      return { rating: 1000, games: 0, wins: 0, losses: 0, rank: null };
    const [row] = await database
      .select()
      .from(ranked)
      .where(eq(ranked.publicId, profile.publicId));
    return row!;
  }
  async function match(userId: string, matchId: string) {
    const [row] = await database
      .select()
      .from(gameResults)
      .where(
        and(
          eq(gameResults.matchId, matchId),
          sql`${userId} in (${gameResults.playerOneId}, ${gameResults.playerTwoId})`,
        ),
      );
    if (!row)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "This match rating is unavailable.",
      });
    const one = row.playerOneId === userId;
    const before = one ? row.playerOneRatingBefore : row.playerTwoRatingBefore;
    const after = one ? row.playerOneRatingAfter : row.playerTwoRatingAfter;
    return before === null || after === null
      ? null
      : { before, after, delta: after - before };
  }
  return { leaderboard, own, match };
}
export const ratingStore = createRatingStore(db);
