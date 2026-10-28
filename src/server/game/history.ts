import { TRPCError } from "@trpc/server";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { db } from "~/server/db";
import { gameProfiles, gameResults } from "~/server/db/schema";
import type { MatchRecord } from "./service";

export type HistoryCursor = { finishedAt: Date; matchId: string };
type HistoryDatabase =
  typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export function createHistoryStore(database: HistoryDatabase) {
  async function saveResult(record: MatchRecord) {
    await database.transaction(async (tx) => {
      await tx
        .insert(gameProfiles)
        .values([
          { userId: record.playerOneId },
          { userId: record.playerTwoId },
        ])
        .onConflictDoNothing();
      await tx
        .insert(gameResults)
        .values(record)
        .onConflictDoNothing({ target: gameResults.matchId });
    });
  }
  async function profile(userId: string) {
    await database
      .insert(gameProfiles)
      .values({ userId })
      .onConflictDoNothing();
    const [value] = await database
      .select({
        publicId: gameProfiles.publicId,
        historyPublic: gameProfiles.historyPublic,
      })
      .from(gameProfiles)
      .where(eq(gameProfiles.userId, userId));
    return value!;
  }
  async function setVisibility(userId: string, historyPublic: boolean) {
    await database
      .insert(gameProfiles)
      .values({ userId, historyPublic })
      .onConflictDoUpdate({
        target: gameProfiles.userId,
        set: { historyPublic },
      });
    return profile(userId);
  }
  const publicConsent = () =>
    and(
      sql<boolean>`exists (select 1 from ${gameProfiles} where ${gameProfiles.userId} = ${gameResults.playerOneId} and ${gameProfiles.historyPublic} = true)`,
      sql<boolean>`exists (select 1 from ${gameProfiles} where ${gameProfiles.userId} = ${gameResults.playerTwoId} and ${gameProfiles.historyPublic} = true)`,
    );
  const participant = (userId: string) =>
    or(
      eq(gameResults.playerOneId, userId),
      eq(gameResults.playerTwoId, userId),
    );
  const access = (viewerId: string | null) =>
    viewerId ? or(participant(viewerId), publicConsent()) : publicConsent();
  const columns = {
    matchId: gameResults.matchId,
    playerOneName: gameResults.playerOneName,
    playerTwoName: gameResults.playerTwoName,
    playerOneScore: gameResults.playerOneScore,
    playerTwoScore: gameResults.playerTwoScore,
    winnerSeat: gameResults.winnerSeat,
    startedAt: gameResults.startedAt,
    finishedAt: gameResults.finishedAt,
    reason: gameResults.reason,
  };
  async function history(
    viewerId: string | null,
    input: { publicId?: string; cursor?: HistoryCursor },
  ) {
    let ownerId = viewerId;
    if (input.publicId) {
      const [owner] = await database
        .select()
        .from(gameProfiles)
        .where(eq(gameProfiles.publicId, input.publicId));
      if (!owner || (!owner.historyPublic && owner.userId !== viewerId))
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "This history is private or unavailable.",
        });
      ownerId = owner.userId;
    }
    if (!ownerId)
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Sign in to view your history.",
      });
    const cursor = input.cursor;
    const rows = await database
      .select(columns)
      .from(gameResults)
      .where(
        and(
          participant(ownerId),
          access(viewerId),
          cursor
            ? or(
                lt(gameResults.finishedAt, cursor.finishedAt),
                and(
                  eq(gameResults.finishedAt, cursor.finishedAt),
                  lt(gameResults.matchId, cursor.matchId),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(gameResults.finishedAt), desc(gameResults.matchId))
      .limit(21);
    const items = rows.slice(0, 20),
      last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > 20 && last
          ? { finishedAt: last.finishedAt, matchId: last.matchId }
          : null,
    };
  }
  async function replay(viewerId: string | null, matchId: string) {
    const [result] = await database
      .select({ ...columns, replay: gameResults.replay })
      .from(gameResults)
      .where(and(eq(gameResults.matchId, matchId), access(viewerId)));
    if (!result)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "This replay is private or unavailable.",
      });
    return result;
  }

  return { saveResult, profile, setVisibility, history, replay };
}
export const { saveResult, profile, setVisibility, history, replay } =
  createHistoryStore(db);
