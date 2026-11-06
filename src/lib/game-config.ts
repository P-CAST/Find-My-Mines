// Next.js embeds the public production address at build time.
// In production, open this same origin in every browser (including the operator's browser).
const productionDomain =
  process.env.NEXT_PUBLIC_PRODUCTION_DOMAIN?.trim() ?? "";
export const SERVER_ADDRESS =
  process.env.NODE_ENV === "production"
    ? productionDomain || (process.env.NEXT_PUBLIC_PRODUCTION_IP ?? "127.0.0.1")
    : "localhost";
export const SERVER_PORT =
  process.env.NODE_ENV === "production"
    ? Number(process.env.NEXT_PUBLIC_PRODUCTION_PORT ?? "3000")
    : 3000;
export const SERVER_PROTOCOL =
  process.env.NODE_ENV === "production"
    ? (process.env.NEXT_PUBLIC_PRODUCTION_PROTOCOL ?? "http")
    : "http";
export const SERVER_ORIGIN =
  process.env.NODE_ENV === "development" && typeof window !== "undefined"
    ? window.location.origin
    : new URL(`${SERVER_PROTOCOL}://${SERVER_ADDRESS}:${SERVER_PORT}`).origin;
