import { networkInterfaces } from "node:os";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { env } from "~/env";
import { SERVER_ORIGIN, SERVER_PORT } from "~/lib/game-config";
import { db } from "~/server/db";

const developmentHosts =
  process.env.NODE_ENV === "development"
    ? [
        "localhost",
        ...Object.values(networkInterfaces()).flatMap((interfaces) =>
          (interfaces ?? []).map(({ address, family }) =>
            family === "IPv6" ? `[${address}]` : address,
          ),
        ),
      ].map((host) => `${host}:${process.env.PORT ?? SERVER_PORT}`)
    : [];

export const auth = betterAuth({
  baseURL:
    process.env.NODE_ENV === "development"
      ? { allowedHosts: developmentHosts, protocol: "http" }
      : SERVER_ORIGIN,
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
  }),
  emailAndPassword: {
    enabled: true,
  },
});

export type Session = typeof auth.$Infer.Session;
