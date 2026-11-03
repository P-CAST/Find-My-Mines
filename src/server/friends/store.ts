import { TRPCError } from "@trpc/server";
import { and, eq, gt, ilike, ne, or, sql, asc } from "drizzle-orm";
import type { db } from "../db";
import { friendships, gameProfiles, user } from "../db/schema";

type Database = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
export type RelationshipAction =
  "send" | "accept" | "decline" | "cancel" | "remove";
export const pairKey = (a: string, b: string) => JSON.stringify([a, b].sort());
export function createFriendStore(database: Database) {
  const pair = (a: string, b: string) => {
    const [one, two] = [a, b].sort();
    return and(
      eq(friendships.accountOne, one!),
      eq(friendships.accountTwo, two!),
    );
  };
  async function target(publicId: string) {
    const [row] = await database
      .select({
        userId: user.id,
        name: user.name,
        publicId: gameProfiles.publicId,
      })
      .from(gameProfiles)
      .innerJoin(user, eq(user.id, gameProfiles.userId))
      .where(eq(gameProfiles.publicId, publicId));
    if (!row)
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Player unavailable.",
      });
    return row;
  }
  async function relationship(a: string, b: string) {
    const [row] = await database.select().from(friendships).where(pair(a, b));
    return row;
  }
  async function change(
    viewer: string,
    other: string,
    action: RelationshipAction,
  ) {
    if (viewer === other)
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Choose another player.",
      });
    // A new account may send a request before ever opening its history/profile.
    await database
      .insert(gameProfiles)
      .values([{ userId: viewer }, { userId: other }])
      .onConflictDoNothing();
    const current = await relationship(viewer, other);
    if (action === "send") {
      if (current) return current.status;
      const [accountOne, accountTwo] = [viewer, other].sort();
      await database
        .insert(friendships)
        .values({
          accountOne: accountOne!,
          accountTwo: accountTwo!,
          requester: viewer,
        })
        .onConflictDoNothing();
      return (await relationship(viewer, other))!.status;
    }
    if (!current) return "none" as const;
    const allowed =
      action === "remove"
        ? current.status === "accepted"
        : current.status === "pending" &&
          (action === "cancel"
            ? current.requester === viewer
            : current.requester !== viewer);
    // Repeated acceptance is safe; a sender still cannot accept their own request.
    if (action === "accept" && current.status === "accepted")
      return "accepted" as const;
    if (!allowed)
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "This action is not available for this request.",
      });
    if (action === "accept") {
      await database
        .update(friendships)
        .set({ status: "accepted", updatedAt: new Date() })
        .where(pair(viewer, other));
      return "accepted" as const;
    }
    await database.delete(friendships).where(pair(viewer, other));
    return "none" as const;
  }
  async function friendIds(viewer: string) {
    const rows = await database
      .select({ one: friendships.accountOne, two: friendships.accountTwo })
      .from(friendships)
      .where(
        and(
          eq(friendships.status, "accepted"),
          or(
            eq(friendships.accountOne, viewer),
            eq(friendships.accountTwo, viewer),
          ),
        ),
      );
    return rows.map((r) => (r.one === viewer ? r.two : r.one));
  }
  async function incomingCount(viewer: string) {
    const [row] = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(friendships)
      .where(
        and(
          eq(friendships.status, "pending"),
          ne(friendships.requester, viewer),
          or(
            eq(friendships.accountOne, viewer),
            eq(friendships.accountTwo, viewer),
          ),
        ),
      );
    return row!.count;
  }
  async function list(
    viewer: string,
    kind: "friends" | "incoming" | "outgoing",
    cursor?: string,
  ) {
    const other = sql<string>`case when ${friendships.accountOne} = ${viewer} then ${friendships.accountTwo} else ${friendships.accountOne} end`;
    const rows = await database
      .select({
        publicId: gameProfiles.publicId,
        name: user.name,
        userId: user.id,
      })
      .from(friendships)
      .innerJoin(user, eq(user.id, other))
      .innerJoin(gameProfiles, eq(gameProfiles.userId, user.id))
      .where(
        and(
          or(
            eq(friendships.accountOne, viewer),
            eq(friendships.accountTwo, viewer),
          ),
          eq(friendships.status, kind === "friends" ? "accepted" : "pending"),
          kind === "friends"
            ? undefined
            : kind === "outgoing"
              ? eq(friendships.requester, viewer)
              : ne(friendships.requester, viewer),
          cursor ? gt(gameProfiles.publicId, cursor) : undefined,
        ),
      )
      .orderBy(asc(gameProfiles.publicId))
      .limit(21);
    return {
      items: rows.slice(0, 20),
      nextCursor: rows.length > 20 ? rows[19]!.publicId : undefined,
    };
  }
  async function search(viewer: string, query: string, cursor?: string) {
    const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    // Profiles are also created for matching accounts that have never opened history.
    await database
      .insert(gameProfiles)
      .select(
        database
          .select({
            rating: sql<number>`1000`.as("rating"),
            ratedGames: sql<number>`0`.as("rated_games"),
            ratedWins: sql<number>`0`.as("rated_wins"),
            ratedLosses: sql<number>`0`.as("rated_losses"),
            userId: user.id,
            publicId: sql<string>`gen_random_uuid()`.as("public_id"),
            historyPublic: sql<boolean>`false`.as("history_public"),
            achievementsPublic: sql<boolean>`false`.as("achievements_public"),
          })
          .from(user)
          .where(ilike(user.name, pattern)),
      )
      .onConflictDoNothing();
    const rows = await database
      .select({
        publicId: gameProfiles.publicId,
        name: user.name,
        status: friendships.status,
        requester: friendships.requester,
      })
      .from(user)
      .innerJoin(gameProfiles, eq(gameProfiles.userId, user.id))
      .leftJoin(
        friendships,
        or(
          and(
            eq(friendships.accountOne, viewer),
            eq(friendships.accountTwo, user.id),
          ),
          and(
            eq(friendships.accountTwo, viewer),
            eq(friendships.accountOne, user.id),
          ),
        ),
      )
      .where(
        and(
          ne(user.id, viewer),
          ilike(user.name, pattern),
          cursor ? gt(gameProfiles.publicId, cursor) : undefined,
        ),
      )
      .orderBy(asc(gameProfiles.publicId))
      .limit(21);
    return {
      items: rows.slice(0, 20).map(({ requester, status, ...r }) => ({
        ...r,
        relationship:
          status === "accepted"
            ? ("friends" as const)
            : status === "pending"
              ? requester === viewer
                ? ("outgoing" as const)
                : ("incoming" as const)
              : ("none" as const),
      })),
      nextCursor: rows.length > 20 ? rows[19]!.publicId : undefined,
    };
  }
  return {
    target,
    relationship,
    change,
    friendIds,
    incomingCount,
    list,
    search,
  };
}
