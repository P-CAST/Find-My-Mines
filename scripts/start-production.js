import { isIPv4 } from "node:net";

const ip = process.env.NEXT_PUBLIC_PRODUCTION_IP ?? "127.0.0.1";
const port = process.env.NEXT_PUBLIC_PRODUCTION_PORT ?? "3000";

if (!isIPv4(ip)) {
  throw new Error("NEXT_PUBLIC_PRODUCTION_IP must be an IPv4 address.");
}
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  throw new Error("NEXT_PUBLIC_PRODUCTION_PORT must be between 1 and 65535.");
}

process.env.HOSTNAME = ip;
process.env.PORT = port;
await import(new URL("./server.js", import.meta.url).href);
