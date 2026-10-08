import { isIPv4 } from "node:net";
import { readFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

// A copied deployment can supply secrets beside the entrypoint. Existing env wins.
try {
  loadEnvFile(fileURLToPath(new URL("./.env", import.meta.url)));
} catch (error) {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    error.code !== "ENOENT"
  ) {
    throw error;
  }
}

const defaults = JSON.parse(
  readFileSync(new URL("./production-config.json", import.meta.url), "utf8"),
);
const ip = process.env.NEXT_PUBLIC_PRODUCTION_IP ?? defaults.ip;
const port =
  process.env.PORT ?? process.env.NEXT_PUBLIC_PRODUCTION_PORT ?? defaults.port;

if (
  ip !== defaults.ip ||
  (process.env.NEXT_PUBLIC_PRODUCTION_PORT ?? defaults.port) !== defaults.port
) {
  throw new Error(
    "Production address differs from the browser bundle. Run pnpm build with the intended NEXT_PUBLIC_PRODUCTION_IP and NEXT_PUBLIC_PRODUCTION_PORT, then copy the new bundle.",
  );
}

if (!isIPv4(ip) || ip === "0.0.0.0") {
  throw new Error(
    "NEXT_PUBLIC_PRODUCTION_IP must be a reachable IPv4 address, not 0.0.0.0.",
  );
}
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  throw new Error("NEXT_PUBLIC_PRODUCTION_PORT must be between 1 and 65535.");
}

// A public VPS address may be forwarded to a private interface. Listen on all IPv4 interfaces.
process.env.HOSTNAME = "0.0.0.0";
process.env.PORT = port;
console.log(
  `Find My Mines: open http://${ip}:${defaults.port} (server port ${port}).`,
);
await import(new URL("./next-server.js", import.meta.url).href);
