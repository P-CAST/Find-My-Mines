export type AchievementMode = "both" | "human" | "bot";
export type AchievementTotals = {
  mines: number;
  games: number;
  combo: number;
  punctualWins: number;
  humanWins: number;
  closeWins: number;
  comebackWins: number;
  botWins: number;
  dominantBotWins: number;
};
export type AchievementDefinition = {
  id: string;
  name: string;
  description: string;
  mode: AchievementMode;
  metric: keyof AchievementTotals;
  target: number;
};
export const ACHIEVEMENTS = [
  {
    id: "first-discovery",
    name: "First Discovery",
    description: "Find your first mine.",
    mode: "both",
    metric: "mines",
    target: 1,
  },
  {
    id: "mine-collector",
    name: "Mine Collector",
    description: "Find 25 mines across games.",
    mode: "both",
    metric: "mines",
    target: 25,
  },
  {
    id: "mine-hunter",
    name: "Mine Hunter",
    description: "Find 100 mines across games.",
    mode: "both",
    metric: "mines",
    target: 100,
  },
  {
    id: "first-expedition",
    name: "First Expedition",
    description: "Complete your first game.",
    mode: "both",
    metric: "games",
    target: 1,
  },
  {
    id: "regular-explorer",
    name: "Regular Explorer",
    description: "Complete 10 games.",
    mode: "both",
    metric: "games",
    target: 10,
  },
  {
    id: "triple-find",
    name: "Triple Find",
    description: "Find three mines during one turn.",
    mode: "both",
    metric: "combo",
    target: 3,
  },
  {
    id: "chain-reaction",
    name: "Chain Reaction",
    description: "Find five mines during one turn.",
    mode: "both",
    metric: "combo",
    target: 5,
  },
  {
    id: "on-the-clock",
    name: "On the Clock",
    description: "Win without timing out on any of your turns.",
    mode: "both",
    metric: "punctualWins",
    target: 1,
  },
  {
    id: "friendly-rival",
    name: "Friendly Rival",
    description: "Win your first game against another account.",
    mode: "human",
    metric: "humanWins",
    target: 1,
  },
  {
    id: "proven-rival",
    name: "Proven Rival",
    description: "Win 10 games against other accounts.",
    mode: "human",
    metric: "humanWins",
    target: 10,
  },
  {
    id: "by-a-whisker",
    name: "By a Whisker",
    description: "Win a human game 6–5.",
    mode: "human",
    metric: "closeWins",
    target: 1,
  },
  {
    id: "comeback",
    name: "Comeback",
    description: "Win a human game after trailing by at least three mines.",
    mode: "human",
    metric: "comebackWins",
    target: 1,
  },
  {
    id: "bot-breaker",
    name: "Bot Breaker",
    description: "Win your first bot game.",
    mode: "bot",
    metric: "botWins",
    target: 1,
  },
  {
    id: "practice-champion",
    name: "Practice Champion",
    description: "Win five bot games.",
    mode: "bot",
    metric: "botWins",
    target: 5,
  },
  {
    id: "outclassed",
    name: "Outclassed",
    description: "Win a bot game with at least nine mines.",
    mode: "bot",
    metric: "dominantBotWins",
    target: 1,
  },
] as const satisfies readonly AchievementDefinition[];
export type AchievementId = (typeof ACHIEVEMENTS)[number]["id"];
export const ACHIEVEMENT_GROUPS = [
  { mode: "both", label: "Bot and human games" },
  { mode: "human", label: "Human games only" },
  { mode: "bot", label: "Bot games only" },
] as const;
export function achievementProgress(totals: AchievementTotals) {
  return ACHIEVEMENTS.map((badge) => ({
    ...badge,
    progress: Math.min(badge.target, totals[badge.metric]),
  }));
}
