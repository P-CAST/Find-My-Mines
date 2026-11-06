import assert from "node:assert/strict";
import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  request as httpsRequest,
  type Server as HttpsServer,
} from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { connect as tlsConnect } from "node:tls";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  assertInternalPortFree,
  createTlsForwarder,
  loadTls,
  productionSettings,
  waitForInternalServer,
} from "../scripts/production-https.js";

const directory = await mkdtemp(join(tmpdir(), "mines-https-"));
after(() => rm(directory, { recursive: true, force: true }));
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost",
    "-keyout",
    join(directory, "key.pem"),
    "-out",
    join(directory, "cert.pem"),
  ],
  { stdio: "ignore" },
);
const tls = loadTls(directory, "cert.pem", "key.pem");
const defaults = {
  ip: "149.28.158.35",
  domain: "netcentric.chayatornounpat.com",
  port: "443",
  protocol: "https",
};

async function listen(server: Server | HttpsServer) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function unusedPort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function call(port: number, path = "/", method = "GET", headers = {}) {
  return httpsRequest({
    hostname: "127.0.0.1",
    port,
    servername: "localhost",
    ca: tls.cert,
    path,
    method,
    headers: { host: "netcentric.chayatornounpat.com", ...headers },
    agent: false,
  });
}

void test("production settings preserve HTTP defaults and distinguish build origin from listener ports", () => {
  assert.equal(
    productionSettings({ ip: "127.0.0.1", port: "80" }, {}).origin,
    "http://127.0.0.1",
  );
  assert.equal(
    productionSettings(defaults, {}).origin,
    "https://netcentric.chayatornounpat.com",
  );
  const settings = productionSettings(defaults, {
    PORT: "8443",
    TLS_CERT_PATH: "cert.pem",
    TLS_KEY_PATH: "key.pem",
  });
  assert.equal(settings.port, 8443);
  assert.equal(settings.internalPort, 3001);
  assert.equal(settings.origin, "https://netcentric.chayatornounpat.com");
  assert.equal(
    productionSettings({ ...defaults, port: "8443" }, {}).origin,
    "https://netcentric.chayatornounpat.com:8443",
  );
  for (const env of [
    { NEXT_PUBLIC_PRODUCTION_PROTOCOL: "http" },
    { NEXT_PUBLIC_PRODUCTION_PORT: "80" },
    { NEXT_PUBLIC_PRODUCTION_DOMAIN: "other.example.com" },
    { NEXT_PUBLIC_PRODUCTION_IP: "127.0.0.1" },
  ])
    assert.throws(() => productionSettings(defaults, env), /browser bundle/);
  for (const env of [
    { TLS_CERT_PATH: "cert.pem" },
    { TLS_KEY_PATH: "key.pem" },
    { PORT: "0" },
    { PORT: "65536" },
    { PORT: "abc" },
    {
      TLS_CERT_PATH: "cert.pem",
      TLS_KEY_PATH: "key.pem",
      TLS_INTERNAL_PORT: "443",
    },
    {
      TLS_CERT_PATH: "cert.pem",
      TLS_KEY_PATH: "key.pem",
      TLS_INTERNAL_PORT: "0",
    },
  ])
    assert.throws(() => productionSettings(defaults, env));
  assert.throws(
    () =>
      productionSettings(
        { ...defaults, protocol: "http" },
        { TLS_CERT_PATH: "cert.pem", TLS_KEY_PATH: "key.pem" },
      ),
    /requires/,
  );
  assert.throws(
    () => productionSettings({ ...defaults, protocol: "ftp" }, {}),
    /http or https/,
  );
});

void test("TLS loading rejects missing, malformed, and mismatched files", async () => {
  assert.throws(
    () => loadTls(directory, "missing.pem", "key.pem"),
    /Cannot load TLS/,
  );
  await writeFile(join(directory, "invalid.pem"), "invalid");
  assert.throws(
    () => loadTls(directory, "invalid.pem", "key.pem"),
    /Cannot load TLS/,
  );
  execFileSync(
    "openssl",
    [
      "genpkey",
      "-algorithm",
      "RSA",
      "-pkeyopt",
      "rsa_keygen_bits:2048",
      "-out",
      join(directory, "other-key.pem"),
    ],
    { stdio: "ignore" },
  );
  assert.throws(
    () => loadTls(directory, "cert.pem", "other-key.pem"),
    /Cannot load TLS/,
  );
});

void test("HTTPS forwarding preserves bodies/cookies and replaces spoofed forwarding metadata", async (t) => {
  const backend = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(201, {
        "set-cookie": [
          "session=one; HttpOnly; Secure",
          "guest=two; HttpOnly; Secure",
        ],
        connection: "x-private",
        "x-private": "remove-me",
      });
      res.end(
        JSON.stringify({
          headers: req.headers,
          method: req.method,
          url: req.url,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
  });
  t.after(() => {
    backend.closeAllConnections();
    backend.close();
  });
  const internal = await listen(backend);
  const forwarder = createTlsForwarder(tls, internal);
  t.after(forwarder.close);
  const port = await listen(forwarder.server);
  const req = call(port, "/api/trpc/action?batch=1", "POST", {
    "x-forwarded-proto": "http",
    "x-forwarded-for": "forged",
    "x-forwarded-host": "evil.test",
    forwarded: "proto=http",
    connection: "x-remove",
    "x-remove": "secret",
    cookie: "session=one",
    origin: "https://netcentric.chayatornounpat.com",
  });
  req.end("request body");
  const [res] = (await once(req, "response")) as [IncomingMessage];
  const chunks: Buffer[] = [];
  for await (const chunk of res) chunks.push(chunk as Buffer);
  assert.equal(res.statusCode, 201);
  assert.equal(res.headers["set-cookie"]?.length, 2);
  assert.equal(res.headers["x-private"], undefined);
  const body = JSON.parse(Buffer.concat(chunks).toString()) as {
    headers: Record<string, string>;
    method: string;
    url: string;
    body: string;
  };
  assert.equal(body.body, "request body");
  assert.equal(body.method, "POST");
  assert.equal(body.url, "/api/trpc/action?batch=1");
  assert.equal(body.headers.host, "netcentric.chayatornounpat.com");
  assert.equal(body.headers["x-forwarded-proto"], "https");
  assert.equal(body.headers["x-forwarded-host"], body.headers.host);
  assert.equal(body.headers["x-forwarded-port"], String(port));
  assert.equal(body.headers["x-forwarded-for"], "127.0.0.1");
  assert.equal(body.headers.forwarded, undefined);
  assert.equal(body.headers["x-remove"], undefined);
  assert.equal(body.headers.cookie, "session=one");
  assert.equal(body.headers.origin, "https://netcentric.chayatornounpat.com");
});

void test(
  "SSE flushes immediately and disconnects cancel both subscription endpoints",
  { timeout: 5000 },
  async (t) => {
    let disconnected: (() => void) | undefined;
    const backend = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      res.on("close", () => disconnected?.());
    });
    t.after(() => {
      backend.closeAllConnections();
      backend.close();
    });
    const forwarder = createTlsForwarder(tls, await listen(backend));
    t.after(forwarder.close);
    const port = await listen(forwarder.server);
    for (const path of ["/api/trpc/events", "/api/messages/events"]) {
      const closed = new Promise<void>((resolve) => {
        disconnected = resolve;
      });
      const req = call(port, path);
      req.end();
      const [res] = (await once(req, "response")) as [IncomingMessage];
      const [data] = (await once(res, "data")) as [Buffer];
      assert.equal(data.toString(), "data: first\n\n");
      res.destroy();
      req.destroy();
      await closed;
    }
    const closed = new Promise<void>((resolve) => {
      disconnected = resolve;
    });
    const req = call(port, "/api/trpc/events");
    req.end();
    const [res] = (await once(req, "response")) as [IncomingMessage];
    res.on("error", () => {
      /* Expected when shutdown interrupts SSE. */
    });
    forwarder.close();
    await closed;
  },
);

void test(
  "truncated upstream streams close the client and missing Host requests return 400",
  { timeout: 5000 },
  async (t) => {
    const backend = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      setTimeout(() => res.destroy(), 20);
    });
    t.after(() => {
      backend.closeAllConnections();
      backend.close();
    });
    const forwarder = createTlsForwarder(tls, await listen(backend));
    t.after(forwarder.close);
    const port = await listen(forwarder.server);
    const req = call(port);
    req.end();
    const [res] = (await once(req, "response")) as [IncomingMessage];
    await assert.rejects(async () => {
      res.resume();
      await once(res, "end");
    });
    assert.equal(res.complete, false);
    const socket = tlsConnect({
      host: "127.0.0.1",
      port,
      servername: "localhost",
      ca: tls.cert,
    });
    await once(socket, "secureConnect");
    socket.write("GET / HTTP/1.0\r\n\r\n");
    const chunks: Buffer[] = [];
    for await (const chunk of socket) chunks.push(chunk as Buffer);
    assert.match(Buffer.concat(chunks).toString(), /^HTTP\/1\.1 400/);
  },
);

void test("upstream refusal returns 502 and occupied internal ports are rejected", async (t) => {
  const internal = await unusedPort();
  await assertInternalPortFree(internal);
  const forwarder = createTlsForwarder(tls, internal);
  t.after(forwarder.close);
  const port = await listen(forwarder.server);
  const req = call(port);
  req.end();
  const [res] = (await once(req, "response")) as [IncomingMessage];
  res.resume();
  assert.equal(res.statusCode, 502);
  await assert.rejects(assertInternalPortFree(port), /unavailable/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    waitForInternalServer(internal, controller.signal),
    /abort/i,
  );
});

void test("public origin uses build protocol while development stays HTTP", () => {
  const code =
    "import {SERVER_ORIGIN} from './src/lib/game-config.ts'; console.log(SERVER_ORIGIN)";
  const run = (
    mode: "development" | "production",
    protocol: string,
    port: string,
  ) =>
    execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code],
      {
        env: {
          ...process.env,
          NODE_ENV: mode,
          NEXT_PUBLIC_PRODUCTION_PROTOCOL: protocol,
          NEXT_PUBLIC_PRODUCTION_DOMAIN: "mines.example.com",
          NEXT_PUBLIC_PRODUCTION_PORT: port,
        },
        encoding: "utf8",
      },
    ).trim();
  assert.equal(run("production", "https", "443"), "https://mines.example.com");
  assert.equal(run("production", "http", "80"), "http://mines.example.com");
  assert.equal(
    run("production", "https", "8443"),
    "https://mines.example.com:8443",
  );
  assert.equal(run("development", "https", "443"), "http://localhost:3000");
});

void test("real tRPC handler accepts the public HTTPS origin, rejects others, and sets Secure cookies", () => {
  // Use a dummy router and an unreachable database address. Anonymous requests
  // require no database queries and never import the game authority.
  const code = `
    import assert from 'node:assert/strict';
    const { createApiHandler } = await import('./src/server/api/handler.ts');
    const { initTRPC } = await import('@trpc/server');
    const { NextRequest } = await import('next/server.js');
    const { auth } = await import('./src/server/better-auth/index.ts');
    const t = initTRPC.create();
    const router = t.router({ ping: t.procedure.query(() => 'ok') });
    const publicOrigin = 'https://netcentric.chayatornounpat.com';
    assert.equal(auth.options.baseURL, publicOrigin);
    for (const endpoint of ['/api/trpc', '/api/messages']) {
      const handler = createApiHandler(endpoint, router);
      const request = (origin, host = 'netcentric.chayatornounpat.com') => new NextRequest(
        'https://127.0.0.1:3001' + endpoint + '/ping',
        { headers: { host, origin } }
      );
      const accepted = await handler(request(publicOrigin));
      assert.equal(accepted.status, 200);
      assert.ok(accepted.headers.getSetCookie().some(cookie => cookie.startsWith('mines-session=') && cookie.includes('; Secure')));
      assert.equal((await handler(request('https://other.example.com'))).status, 403);
      assert.equal((await handler(request('http://netcentric.chayatornounpat.com'))).status, 403);
      assert.equal((await handler(request(publicOrigin + ':8443', 'netcentric.chayatornounpat.com:8443'))).status, 200);
    }
  `;
  execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", code],
    {
      env: {
        ...process.env,
        NODE_ENV: "production",
        DATABASE_URL: "postgresql://unused:unused@127.0.0.1:1/unused",
        BETTER_AUTH_SECRET:
          "test-only-unused-secret-at-least-thirty-two-characters",
        NEXT_PUBLIC_PRODUCTION_DOMAIN: "netcentric.chayatornounpat.com",
        NEXT_PUBLIC_PRODUCTION_IP: "149.28.158.35",
        NEXT_PUBLIC_PRODUCTION_PORT: "443",
        NEXT_PUBLIC_PRODUCTION_PROTOCOL: "https",
      },
      timeout: 10000,
      stdio: "pipe",
    },
  );
});

async function stopped(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null)
    await once(child, "exit");
}

void test(
  "copied launcher loads relative TLS paths and stops a fixture server without a database",
  { timeout: 15000 },
  async (t) => {
    const deploy = join(directory, "deployment");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(deploy);
    for (const [source, target] of [
      ["start-production.js", "start.js"],
      ["production-https.js", "production-https.js"],
    ] as const)
      await copyFile(
        new URL(`../scripts/${source}`, import.meta.url),
        join(deploy, target),
      );
    await copyFile(join(directory, "cert.pem"), join(deploy, "cert.pem"));
    await copyFile(join(directory, "key.pem"), join(deploy, "key.pem"));
    await writeFile(
      join(deploy, "package.json"),
      JSON.stringify({ type: "module" }),
    );
    await writeFile(
      join(deploy, "production-config.json"),
      JSON.stringify(defaults),
    );
    await writeFile(join(deploy, "server.js"), 'import "./start.js";');
    const internal = await unusedPort();
    const port = await unusedPort();
    await writeFile(
      join(deploy, ".env"),
      `TLS_CERT_PATH=cert.pem\nTLS_KEY_PATH=key.pem\nTLS_INTERNAL_PORT=${internal}\nPORT=${port}\n`,
    );
    await writeFile(
      join(deploy, "next-server.js"),
      `
    import { createServer } from 'node:http';
    const server = createServer((req, res) => res.end(req.headers['x-forwarded-proto']));
    server.listen(Number(process.env.PORT), process.env.HOSTNAME);
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
  `,
    );
    const env = { ...process.env };
    for (const name of Object.keys(env))
      if (
        name.startsWith("NEXT_PUBLIC_PRODUCTION_") ||
        name.startsWith("TLS_") ||
        name === "PORT"
      )
        delete env[name];
    const child = spawn(process.execPath, [join(deploy, "server.js")], {
      env,
      cwd: tmpdir(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(async () => {
      if (child.exitCode === null) child.kill("SIGKILL");
      await stopped(child);
    });
    let output = "";
    await new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) =>
        reject(new Error(`Launcher exited ${code}: ${output}`)),
      );
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes("Find My Mines: open")) resolve();
        });
    });
    assert.match(
      output,
      /https:\/\/netcentric\.chayatornounpat\.com \(HTTPS port/,
    );
    const controller = new AbortController();
    await waitForInternalServer(internal, controller.signal);
    const socket = connect({ host: "127.0.0.1", port: internal });
    await once(socket, "connect");
    socket.destroy();
    const req = call(port);
    req.end();
    const [res] = (await once(req, "response")) as [IncomingMessage];
    const chunks: Buffer[] = [];
    for await (const chunk of res) chunks.push(chunk as Buffer);
    assert.equal(Buffer.concat(chunks).toString(), "https");
    child.kill("SIGTERM");
    await stopped(child);
    assert.equal(child.exitCode, 0);
    await assertInternalPortFree(internal);
    await assertInternalPortFree(port);
    assert.ok(
      !(
        await readFile(join(deploy, "production-config.json"), "utf8")
      ).includes("TLS_"),
    );
    // A bad certificate or either occupied port must fail without a surviving listener.
    const failed = (overrides: Partial<NodeJS.ProcessEnv>) =>
      spawnSync(process.execPath, [join(deploy, "server.js")], {
        env: { ...env, ...overrides },
        cwd: tmpdir(),
        encoding: "utf8",
        timeout: 3000,
      });
    const missing = failed({ TLS_CERT_PATH: "missing.pem" });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Cannot load TLS/);
    await assertInternalPortFree(internal);
    const occupied = createServer();
    const occupiedPort = await listen(occupied);
    t.after(() => occupied.close());
    const internalFailure = failed({ TLS_INTERNAL_PORT: String(occupiedPort) });
    assert.equal(internalFailure.status, 1);
    assert.match(internalFailure.stderr, /unavailable/);
    const publicFailure = failed({ PORT: String(occupiedPort) });
    assert.equal(publicFailure.status, 1);
    assert.match(publicFailure.stderr, /EADDRINUSE/);
    await assertInternalPortFree(internal);
    await assertInternalPortFree(port);
    assert.ok(occupied.listening);

    // With no TLS paths an old-format HTTP bundle keeps its original behavior.
    await writeFile(
      join(deploy, "production-config.json"),
      JSON.stringify({ ip: "127.0.0.1", port: String(port) }),
    );
    await writeFile(join(deploy, ".env"), "");
    const plain = spawn(process.execPath, [join(deploy, "server.js")], {
      env,
      cwd: tmpdir(),
      stdio: "ignore",
    });
    t.after(async () => {
      if (plain.exitCode === null) plain.kill("SIGKILL");
      await stopped(plain);
    });
    await waitForInternalServer(port, new AbortController().signal);
    plain.kill("SIGTERM");
    await stopped(plain);
    assert.equal(plain.exitCode, 0);
    await assertInternalPortFree(port);
  },
);
