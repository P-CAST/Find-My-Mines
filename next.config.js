/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import { env } from "./src/env.js";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";

/** @param {string} phase @returns {import("next").NextConfig} */
const config = (phase) => ({
  // Production builds must not overwrite a running development server's output.
  distDir: phase === PHASE_DEVELOPMENT_SERVER ? ".next" : "dist",
  output: "standalone",
  env: {
    NEXT_PUBLIC_PRODUCTION_DOMAIN: env.NEXT_PUBLIC_PRODUCTION_DOMAIN ?? "",
    NEXT_PUBLIC_PRODUCTION_IP: env.NEXT_PUBLIC_PRODUCTION_IP,
    NEXT_PUBLIC_PRODUCTION_PORT: env.NEXT_PUBLIC_PRODUCTION_PORT,
  },
});

export default config;
