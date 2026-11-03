import { eloChange } from "~/lib/elo";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { db } from "~/server/db";
import { gameAnalyses, gameProfiles, gameResults } from "~/server/db/schema";
import { persistAchievementSummaries } from "./achievements";
import type { SavedAnalysis } from "./analysis";
import type { MatchRecord, MatchCompletion } from "./service";

export type HistoryCursor = { finishedAt: Date; matchId: string };
type HistoryDatabase =
  typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export function createHistoryStore(database: HistoryDatabase) {
  async function saveCompletion(completion: MatchCompletion) {
    await database.transaction(async (tx) => {
      const record = completion.result;
      const userIds = [
        ...new Set([
          ...completion.summaries.map((fact) => fact.userId),
          ...(record ? [record.playerOneId, record.playerTwoId] : []),
        ]),
      ].sort();
      // Lock consistently before results or counters: retries and concurrent matches
      // for an account must observe each other's committed progress.
      for (const userId of userIds) {
        await tx.insert(gameProfiles).values({ userId }).onConflictDoNothing();
        await tx
          .select({ userId: gameProfiles.userId })
          .from(gameProfiles)
          .where(eq(gameProfiles.userId, userId))
          .for("update");
      }
      if (record) {
        if (
          record.playerOneId === record.playerTwoId ||
          ![0, 1].includes(record.winnerSeat)
        )
          throw new Error("Invalid rated match participants or winner");
        const profiles = await tx
          .select()
          .from(gameProfiles)
          .where(
            or(
              eq(gameProfiles.userId, record.playerOneId),
              eq(gameProfiles.userId, record.playerTwoId),
            ),
          );
        const one = profiles.find((p) => p.userId === record.playerOneId)!;
        const two = profiles.find((p) => p.userId === record.playerTwoId)!;
        const delta = eloChange(
          one.rating,
          two.rating,
          record.winnerSeat === 0,
        );
        const inserted = await tx
          .insert(gameResults)
          .values({
            ...record,
            playerOneRatingBefore: one.rating,
            playerOneRatingAfter: one.rating + delta,
            playerTwoRatingBefore: two.rating,
            playerTwoRatingAfter: two.rating - delta,
          })
          .onConflictDoNothing({ target: gameResults.matchId })
          .returning({ matchId: gameResults.matchId });
        if (inserted.length) {
          for (const [seat, p] of [one, two].entries()) {
            const won = record.winnerSeat === seat;
            await tx
              .update(gameProfiles)
              .set({
                rating: p.rating + (seat === 0 ? delta : -delta),
                ratedGames: p.ratedGames + 1,
                ratedWins: p.ratedWins + Number(won),
                ratedLosses: p.ratedLosses + Number(!won),
              })
              .where(eq(gameProfiles.userId, p.userId));
          }
        }
      }
      await persistAchievementSummaries(tx, completion.summaries);
    });
  }
  async function saveResult(record: MatchRecord) {
    await saveCompletion({
      matchId: record.matchId,
      result: record,
      summaries: [],
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

  async function analysisSource(
    viewerId: string | null,
    matchId: string,
    participantOnly = false,
  ) {
    const [result] = await database
      .select({
        replay: gameResults.replay,
        winnerSeat: gameResults.winnerSeat,
        reason: gameResults.reason,
        isParticipant: viewerId
          ? sql<boolean>`(${participant(viewerId)})`
          : sql<boolean>`false`,
      })
      .from(gameResults)
      .where(
        and(
          eq(gameResults.matchId, matchId),
          participantOnly
            ? viewerId
              ? participant(viewerId)
              : sql`false`
            : access(viewerId),
        ),
      );
    if (!result)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "This replay is private or unavailable.",
      });
    return result;
  }
  async function readAnalysis(
    viewerId: string | null,
    matchId: string,
    version: number,
  ) {
    // Join current match permissions on every read, including cached reports.
    const [result] = await database
      .select({ analysis: gameAnalyses })
      .from(gameAnalyses)
      .innerJoin(gameResults, eq(gameResults.matchId, gameAnalyses.matchId))
      .where(
        and(
          eq(gameAnalyses.matchId, matchId),
          eq(gameAnalyses.version, version),
          access(viewerId),
        ),
      );
    return result?.analysis ?? null;
  }
  async function saveAnalysis(analysis: SavedAnalysis) {
    await database.insert(gameAnalyses).values(analysis).onConflictDoNothing();
    const [saved] = await database
      .select()
      .from(gameAnalyses)
      .where(
        and(
          eq(gameAnalyses.matchId, analysis.matchId),
          eq(gameAnalyses.version, analysis.version),
        ),
      );
    if (!saved) throw new Error("Analysis was not saved");
    return saved;
  }

  return {
    saveCompletion,
    saveResult,
    profile,
    setVisibility,
    history,
    replay,
    analysisSource,
    readAnalysis,
    saveAnalysis,
  };
}
export const {
  saveCompletion,
  saveResult,
  profile,
  setVisibility,
  history,
  replay,
  analysisSource,
  readAnalysis,
  saveAnalysis,
} = createHistoryStore(db);
