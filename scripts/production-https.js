import { readFileSync } from "node:fs";
import { Agent, request } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, createServer as createNetServer, isIPv4 } from "node:net";
import { resolve } from "node:path";
import { createSecureContext } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";

/** @param {string} value @param {string} name */
function portNumber(value, name) {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
    throw new Error(`${name} must be between 1 and 65535.`);
  return Number(value);
}

/**
 * @param {{ ip: string; domain?: string; port: string; protocol?: string }} defaults
 * @param {Record<string, string | undefined>} env
 */
export function productionSettings(defaults, env) {
  const protocol = defaults.protocol ?? "http";
  const ip = env.NEXT_PUBLIC_PRODUCTION_IP ?? defaults.ip;
  const domain =
    env.NEXT_PUBLIC_PRODUCTION_DOMAIN?.trim() ?? defaults.domain ?? "";
  if (
    ip !== defaults.ip ||
    domain !== (defaults.domain ?? "") ||
    (env.NEXT_PUBLIC_PRODUCTION_PORT ?? defaults.port) !== defaults.port ||
    (env.NEXT_PUBLIC_PRODUCTION_PROTOCOL ?? protocol) !== protocol
  )
    throw new Error(
      "Production address/protocol differs from the browser bundle. Run pnpm build with the intended NEXT_PUBLIC_PRODUCTION_* settings and copy the new bundle.",
    );
  if (protocol !== "http" && protocol !== "https")
    throw new Error("NEXT_PUBLIC_PRODUCTION_PROTOCOL must be http or https.");
  if (!isIPv4(ip) || ip === "0.0.0.0")
    throw new Error(
      "NEXT_PUBLIC_PRODUCTION_IP must be a reachable IPv4 address, not 0.0.0.0.",
    );
  const publicPort = portNumber(defaults.port, "NEXT_PUBLIC_PRODUCTION_PORT");
  const port = portNumber(env.PORT ?? defaults.port, "PORT");
  const certPath = env.TLS_CERT_PATH?.trim();
  const keyPath = env.TLS_KEY_PATH?.trim();
  if (!!certPath !== !!keyPath)
    throw new Error(
      "TLS_CERT_PATH and TLS_KEY_PATH must be supplied together.",
    );
  if (certPath && protocol !== "https")
    throw new Error(
      "Direct TLS requires NEXT_PUBLIC_PRODUCTION_PROTOCOL=https at build time.",
    );
  const internalPort = certPath
    ? portNumber(env.TLS_INTERNAL_PORT ?? "3001", "TLS_INTERNAL_PORT")
    : undefined;
  if (internalPort === port)
    throw new Error(
      "TLS_INTERNAL_PORT must differ from the HTTPS listening PORT.",
    );
  return {
    port,
    internalPort,
    certPath,
    keyPath,
    origin: new URL(`${protocol}://${domain || ip}:${publicPort}`).origin,
  };
}

/** @param {string} directory @param {string} certPath @param {string} keyPath */
export function loadTls(directory, certPath, keyPath) {
  try {
    const options = {
      cert: readFileSync(resolve(directory, certPath)),
      key: readFileSync(resolve(directory, keyPath)),
    };
    createSecureContext(options); // Detect malformed files and mismatched keys before starting Next.
    return options;
  } catch (error) {
    throw new Error(
      "Cannot load TLS_CERT_PATH/TLS_KEY_PATH. Check file permissions and matching PEM certificate/private key.",
      { cause: error },
    );
  }
}

/** @param {import("node:http").IncomingHttpHeaders} source */
function endToEndHeaders(source) {
  const headers = { ...source };
  const connection =
    source.connection?.split(",").map((name) => name.trim().toLowerCase()) ??
    [];
  for (const name of [
    ...connection,
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ])
    delete headers[name];
  return headers;
}

/** @param {import("node:https").ServerOptions} tls @param {number} internalPort */
export function createTlsForwarder(tls, internalPort) {
  const agent = new Agent({ keepAlive: true });
  /** @type {Set<import("node:http").ClientRequest>} */
  const requests = new Set();
  const server = createHttpsServer(tls, (req, res) => {
    if (!req.headers.host) {
      res.writeHead(400, { connection: "close" });
      res.end("Host header required.");
      return;
    }
    const headers = endToEndHeaders(req.headers);
    // Do not trust forwarding metadata supplied by the public client.
    for (const name of Object.keys(headers))
      if (name === "forwarded" || name.startsWith("x-forwarded-"))
        delete headers[name];
    headers.host = req.headers.host;
    headers["x-forwarded-host"] = req.headers.host;
    headers["x-forwarded-proto"] = "https";
    headers["x-forwarded-port"] = String(req.socket.localPort);
    headers["x-forwarded-for"] = req.socket.remoteAddress;
    const upstream = request(
      {
        hostname: "127.0.0.1",
        port: internalPort,
        method: req.method,
        path: req.url,
        headers,
        agent,
      },
      (incoming) => {
        incoming.on("error", () => res.destroy());
        res.writeHead(
          incoming.statusCode ?? 502,
          endToEndHeaders(incoming.headers),
        );
        res.flushHeaders();
        incoming.pipe(res);
      },
    );
    requests.add(upstream);
    upstream.on("close", () => requests.delete(upstream));
    upstream.on("error", () => {
      if (res.destroyed) return;
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(502, {
          "content-type": "text/plain",
          "cache-control": "no-store",
        });
        res.end("Application server unavailable.");
      }
    });
    const cancel = () => upstream.destroy();
    req.on("aborted", cancel);
    req.on("error", cancel);
    res.on("close", cancel);
    req.pipe(upstream);
  });
  server.setTimeout(0); // SSE responses may remain open indefinitely.
  server.on("upgrade", (_req, socket) => socket.destroy());
  // Include incomplete TLS handshakes in bounded shutdown cleanup.
  /** @type {Set<import("node:stream").Duplex>} */
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const close = () => {
    server.close();
    for (const upstream of requests) upstream.destroy();
    for (const socket of sockets) socket.destroy();
    agent.destroy();
  };
  return { server, close };
}

/** @param {number} port */
export async function assertInternalPortFree(port) {
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  }).catch((error) => {
    throw new Error(
      `TLS_INTERNAL_PORT ${port} is unavailable. Choose an unused port.`,
      { cause: error },
    );
  });
}

/** @param {number} port @param {AbortSignal} signal */
export async function waitForInternalServer(port, signal) {
  const deadline = Date.now() + 10_000;
  while (!signal.aborted && Date.now() < deadline) {
    const ready = await new Promise((resolve) => {
      const socket = connect({ host: "127.0.0.1", port, signal });
      socket.setTimeout(250, () => socket.destroy());
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
      socket.once("close", () => resolve(false));
    });
    if (ready) return;
    await delay(50, undefined, { signal });
  }
  signal.throwIfAborted();
  throw new Error("Timed out waiting for the internal Next.js listener.");
}
