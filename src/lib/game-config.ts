// Next.js embeds the public production address at build time.
// Open this same origin in every browser (including the operator's browser).
const productionDomain = process.env.NEXT_PUBLIC_PRODUCTION_DOMAIN?.trim() ?? "";
export const SERVER_ADDRESS =
  process.env.NODE_ENV === "production"
    ? productionDomain || (process.env.NEXT_PUBLIC_PRODUCTION_IP ?? "127.0.0.1")
    : "localhost";
export const SERVER_PORT =
  process.env.NODE_ENV === "production"
    ? Number(process.env.NEXT_PUBLIC_PRODUCTION_PORT ?? "3000")
    : 3000;
export const SERVER_PROTOCOL = "http";
export const SERVER_ORIGIN = `${SERVER_PROTOCOL}://${SERVER_ADDRESS}:${SERVER_PORT}`;
