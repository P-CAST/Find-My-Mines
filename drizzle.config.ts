import { type Config } from "drizzle-kit";

import { env } from "~/env";

export default {
  schema: "./src/server/db/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: env.DATABASE_URL,
  },
  tablesFilter: [
    "user",
    "session",
    "account",
    "verification",
    "post",
    "game_profile",
    "game_result",
    "game_analysis",
  ],
} satisfies Config;
