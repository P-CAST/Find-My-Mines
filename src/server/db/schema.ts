import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  pgTableCreator,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { MatchRecord } from "../game/service";
import type { AnalysisDocument } from "../game/analysis";

export const createTable = pgTableCreator((name) => name);

export const posts = createTable(
  "post",
  (d) => ({
    id: d.integer().primaryKey().generatedByDefaultAsIdentity(),
    name: d.varchar({ length: 256 }),
    createdById: d
      .varchar({ length: 255 })
      .notNull()
      .references(() => user.id),
    createdAt: d
      .timestamp({ withTimezone: true })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: d.timestamp({ withTimezone: true }).$onUpdate(() => new Date()),
  }),
  (t) => [
    index("created_by_idx").on(t.createdById),
    index("name_idx").on(t.name),
  ],
);

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified")
    .$defaultFn(() => false)
    .notNull(),
  image: text("image"),
  role: text("role").default("user").notNull(),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: timestamp("ban_expires"),
  createdAt: timestamp("created_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
  updatedAt: timestamp("updated_at")
    .$defaultFn(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  impersonatedBy: text("impersonated_by"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").$defaultFn(
    () => /* @__PURE__ */ new Date(),
  ),
  updatedAt: timestamp("updated_at").$defaultFn(
    () => /* @__PURE__ */ new Date(),
  ),
});

export const userRelations = relations(user, ({ many }) => ({
  account: many(account),
  session: many(session),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const gameProfiles = createTable(
  "game_profile",
  {
    rating: integer("rating").default(1000).notNull(),
    ratedGames: integer("rated_games").default(0).notNull(),
    ratedWins: integer("rated_wins").default(0).notNull(),
    ratedLosses: integer("rated_losses").default(0).notNull(),
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, { onDelete: "cascade" }),
    publicId: uuid("public_id").defaultRandom().notNull().unique(),
    historyPublic: boolean("history_public").default(false).notNull(),
    achievementsPublic: boolean("achievements_public").default(false).notNull(),
  },
  (t) => [
    index("game_profile_leaderboard_idx")
      .on(t.rating.desc(), t.publicId)
      .where(sql`${t.ratedGames} > 0`),
  ],
);

export const gameResults = createTable(
  "game_result",
  {
    matchId: uuid("match_id").primaryKey(),
    playerOneId: text("player_one_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    playerTwoId: text("player_two_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    playerOneName: text("player_one_name").notNull(),
    playerTwoName: text("player_two_name").notNull(),
    playerOneScore: integer("player_one_score").notNull(),
    playerTwoScore: integer("player_two_score").notNull(),
    winnerSeat: integer("winner_seat").notNull(),
    playerOneRatingBefore: integer("player_one_rating_before"),
    playerOneRatingAfter: integer("player_one_rating_after"),
    playerTwoRatingBefore: integer("player_two_rating_before"),
    playerTwoRatingAfter: integer("player_two_rating_after"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    reason: text("reason", { enum: ["completed", "forfeit"] }).notNull(),
    replay: jsonb("replay").$type<MatchRecord["replay"]>().notNull(),
  },
  (t) => [
    index("game_result_player_one_history_idx").on(
      t.playerOneId,
      t.finishedAt.desc(),
      t.matchId.desc(),
    ),
    index("game_result_player_two_history_idx").on(
      t.playerTwoId,
      t.finishedAt.desc(),
      t.matchId.desc(),
    ),
  ],
);

export const gameAnalyses = createTable(
  "game_analysis",
  {
    matchId: uuid("match_id")
      .notNull()
      .references(() => gameResults.matchId, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    model: text("model").notNull(),
    document: jsonb("document").$type<AnalysisDocument>().notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
  },
  (t) => [primaryKey({ columns: [t.matchId, t.version] })],
);

export const friendships = createTable(
  "friendship",
  {
    accountOne: text("account_one")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountTwo: text("account_two")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    requester: text("requester").notNull(),
    status: text("status", { enum: ["pending", "accepted"] })
      .notNull()
      .default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountOne, t.accountTwo] }),
    index("friendship_account_two_idx").on(t.accountTwo),
    check(
      "friendship_order",
      sql`${t.accountOne} collate "C" < ${t.accountTwo} collate "C"`,
    ),
    check(
      "friendship_requester",
      sql`${t.requester} in (${t.accountOne}, ${t.accountTwo})`,
    ),
    check("friendship_status", sql`${t.status} in ('pending', 'accepted')`),
  ],
);

export const achievementSummaries = createTable(
  "achievement_summary",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    matchId: uuid("match_id").notNull(),
    mode: text("mode", { enum: ["human", "bot"] }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
    won: boolean("won").notNull(),
    score: integer("score").notNull(),
    maxCombo: integer("max_combo").notNull(),
    timeouts: integer("timeouts").notNull(),
    maxDeficit: integer("max_deficit").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.matchId] })],
);

export const earnedBadges = createTable(
  "earned_badge",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    achievementId: text("achievement_id").notNull(),
    unlockedAt: timestamp("unlocked_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.achievementId] })],
);
