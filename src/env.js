import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  /**
   * Specify your server-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars.
   */
  server: {
    BETTER_AUTH_SECRET:
      process.env.NODE_ENV === "production"
        ? z.string()
        : z.string().optional(),
    GAME_OPERATOR_PASSWORD: z.string().min(16).optional(),
    DATABASE_URL: z.string().url(),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
  },

  /**
   * Specify your client-side environment variables schema here. This way you can ensure the app
   * isn't built with invalid env vars. To expose them to the client, prefix them with
   * `NEXT_PUBLIC_`.
   */
  client: {
    NEXT_PUBLIC_PRODUCTION_IP: z
      .string()
      .ip({ version: "v4" })
      .default("127.0.0.1"),
    NEXT_PUBLIC_PRODUCTION_PORT: z
      .string()
      .regex(/^\d+$/)
      .refine((value) => Number(value) >= 1 && Number(value) <= 65535, {
        message: "Production port must be between 1 and 65535",
      })
      .default("3000"),
  },

  /**
   * You can't destruct `process.env` as a regular object in the Next.js edge runtimes (e.g.
   * middlewares) or client-side so we need to destruct manually.
   */
  runtimeEnv: {
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    GAME_OPERATOR_PASSWORD: process.env.GAME_OPERATOR_PASSWORD,
    DATABASE_URL: process.env.DATABASE_URL,
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_PRODUCTION_IP: process.env.NEXT_PUBLIC_PRODUCTION_IP,
    NEXT_PUBLIC_PRODUCTION_PORT: process.env.NEXT_PUBLIC_PRODUCTION_PORT,
  },
  /**
   * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially
   * useful for Docker builds.
   */
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  /**
   * Makes it so that empty strings are treated as undefined. `SOME_VAR: z.string()` and
   * `SOME_VAR=''` will throw an error.
   */
  emptyStringAsUndefined: true,
});
