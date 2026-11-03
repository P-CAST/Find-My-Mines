import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import {
  achievementProgress,
  type AchievementTotals,
} from "~/lib/achievements";
import { db } from "~/server/db";
import {
  achievementSummaries as summaries,
  earnedBadges,
  gameProfiles,
} from "~/server/db/schema";
import type { AchievementSummary } from "./service";

type Database = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function achievementTotals(
  database: Database,
  userId: string,
): Promise<AchievementTotals> {
  const count = (condition: ReturnType<typeof sql>) =>
    sql<number>`count(*) filter (where ${condition})`.mapWith(Number);
  const [totals] = await database
    .select({
      mines: sql<number>`coalesce(sum(${summaries.score}), 0)`.mapWith(Number),
      games: sql<number>`count(*)`.mapWith(Number),
      combo: sql<number>`coalesce(max(${summaries.maxCombo}), 0)`.mapWith(
        Number,
      ),
      punctualWins: count(sql`${summaries.won} and ${summaries.timeouts} = 0`),
      humanWins: count(sql`${summaries.won} and ${summaries.mode} = 'human'`),
      closeWins: count(
        sql`${summaries.won} and ${summaries.mode} = 'human' and ${summaries.score} = 6`,
      ),
      comebackWins: count(
        sql`${summaries.won} and ${summaries.mode} = 'human' and ${summaries.maxDeficit} >= 3`,
      ),
      botWins: count(sql`${summaries.won} and ${summaries.mode} = 'bot'`),
      dominantBotWins: count(
        sql`${summaries.won} and ${summaries.mode} = 'bot' and ${summaries.score} >= 9`,
      ),
    })
    .from(summaries)
    .where(eq(summaries.userId, userId));
  return totals!;
}

// Caller holds each account's profile row lock until its completion transaction commits.
export async function persistAchievementSummaries(
  database: Database,
  facts: AchievementSummary[],
) {
  for (const fact of [...facts].sort((a, b) =>
    a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0,
  )) {
    const inserted = await database
      .insert(summaries)
      .values(fact)
      .onConflictDoNothing()
      .returning({ userId: summaries.userId });
    if (!inserted.length) continue;
    const progress = achievementProgress(
      await achievementTotals(database, fact.userId),
    );
    const earned = progress
      .filter((badge) => badge.progress >= badge.target)
      .map((badge) => ({
        userId: fact.userId,
        achievementId: badge.id,
        unlockedAt: fact.finishedAt,
      }));
    if (earned.length)
      await database.insert(earnedBadges).values(earned).onConflictDoNothing();
  }
}

export function createAchievementStore(database: Database) {
  async function own(userId: string) {
    await database
      .insert(gameProfiles)
      .values({ userId })
      .onConflictDoNothing();
    const [profile] = await database
      .select({
        publicId: gameProfiles.publicId,
        achievementsPublic: gameProfiles.achievementsPublic,
      })
      .from(gameProfiles)
      .where(eq(gameProfiles.userId, userId));
    const badges = await database
      .select({
        id: earnedBadges.achievementId,
        unlockedAt: earnedBadges.unlockedAt,
      })
      .from(earnedBadges)
      .where(eq(earnedBadges.userId, userId));
    return {
      ...profile!,
      badges,
      catalogue: achievementProgress(await achievementTotals(database, userId)),
    };
  }
  async function publicCollection(publicId: string) {
    // Evaluate current consent within the same SQL statement that reads badges.
    const rows = await database
      .select({
        id: earnedBadges.achievementId,
        unlockedAt: earnedBadges.unlockedAt,
      })
      .from(gameProfiles)
      .leftJoin(earnedBadges, eq(earnedBadges.userId, gameProfiles.userId))
      .where(
        and(
          eq(gameProfiles.publicId, publicId),
          eq(gameProfiles.achievementsPublic, true),
        ),
      );
    if (!rows.length)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "These achievements are private or unavailable.",
      });
    return {
      badges: rows.flatMap((row) =>
        row.id && row.unlockedAt
          ? [{ id: row.id, unlockedAt: row.unlockedAt }]
          : [],
      ),
    };
  }
  async function setVisibility(userId: string, achievementsPublic: boolean) {
    await database
      .insert(gameProfiles)
      .values({ userId, achievementsPublic })
      .onConflictDoUpdate({
        target: gameProfiles.userId,
        set: { achievementsPublic },
      });
    return { achievementsPublic };
  }
  return { own, publicCollection, setVisibility };
}
export const achievementStore = createAchievementStore(db);
