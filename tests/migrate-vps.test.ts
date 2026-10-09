import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { test } from "node:test";
import { readVpsConfig, runVpsMigration } from "../scripts/migrate-vps";

const env = {
  ...process.env,
  VPS_SSH_TARGET: "deploy@example.test",
  VPS_DATABASE_URL:
    "postgresql://remote:private%40password@127.0.0.1:5432/production",
  VPS_SSH_PORT: "",
  VPS_TUNNEL_PORT: "15432",
  DATABASE_URL: "postgresql://local:local@localhost:5432/development",
};

void test("VPS configuration requires an explicit remote URL and preserves credentials through the tunnel", () => {
  assert.throws(
    () => readVpsConfig({ ...env, VPS_DATABASE_URL: "" }),
    /VPS_DATABASE_URL/,
  );
  assert.throws(
    () => readVpsConfig({ ...env, VPS_SSH_TARGET: "-F config" }),
    /VPS_SSH_TARGET/,
  );
  assert.throws(
    () => readVpsConfig({ ...env, VPS_TUNNEL_PORT: "0" }),
    /VPS_TUNNEL_PORT/,
  );
  assert.throws(
    () =>
      readVpsConfig({
        ...env,
        VPS_DATABASE_URL: env.VPS_DATABASE_URL + "?host=other",
      }),
    /host query/,
  );
  const config = readVpsConfig(env);
  assert.equal(config.forward, "127.0.0.1:15432:127.0.0.1:5432");
  assert.equal(
    config.databaseUrl,
    "postgresql://remote:private%40password@127.0.0.1:15432/production",
  );
  assert.equal(config.sshPort, undefined);
});

const readyTunnel =
  "console.log('find-my-mines-tunnel-ready'); setInterval(() => {}, 1000)";
type StartProcess = NonNullable<Parameters<typeof runVpsMigration>[1]>;

function fixture(
  tunnelCode: string,
  migrationCode: string,
  onMigration?: (tunnel: ChildProcess) => void,
) {
  const children: ChildProcess[] = [];
  let migrations = 0;
  const start: StartProcess = (command, args, options) => {
    const isSsh = command === "ssh";
    if (isSsh) {
      assert.ok(args.includes("ExitOnForwardFailure=yes"));
      assert.ok(args.includes("ControlPath=none"));
    } else {
      migrations++;
      assert.equal(args.at(-1), "migrate");
      assert.equal(options.env?.DATABASE_URL, readVpsConfig(env).databaseUrl);
    }
    const child = spawn(
      process.execPath,
      ["-e", isSsh ? tunnelCode : migrationCode],
      options,
    );
    children.push(child);
    if (!isSsh) onMigration?.(children[0]!);
    return child;
  };
  return { start, children, migrations: () => migrations };
}

function assertStopped(children: ChildProcess[]) {
  for (const child of children) {
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  }
}

void test("successful migration targets the tunnel, preserves local env, and closes SSH", async () => {
  const localUrl = env.DATABASE_URL;
  const f = fixture(readyTunnel, "process.exit(0)");
  await runVpsMigration(env, f.start);
  assert.equal(f.migrations(), 1);
  assert.equal(env.DATABASE_URL, localUrl);
  assertStopped(f.children);
});

void test("SSH startup failure never starts a migration", async () => {
  const f = fixture("process.exit(1)", "process.exit(0)");
  await assert.rejects(runVpsMigration(env, f.start), /SSH tunnel closed/);
  assert.equal(f.migrations(), 0);
  assertStopped(f.children);
});

void test("migration failure closes the SSH tunnel", async () => {
  const f = fixture(readyTunnel, "process.exit(7)");
  await assert.rejects(
    runVpsMigration(env, f.start),
    /Drizzle migration failed \(7\)/,
  );
  assertStopped(f.children);
});

void test("lost SSH connection stops an active migration", async () => {
  const f = fixture(readyTunnel, "setInterval(() => {}, 1000)", (tunnel) => {
    tunnel.kill("SIGTERM");
  });
  await assert.rejects(runVpsMigration(env, f.start), /SSH tunnel closed/);
  assertStopped(f.children);
});

void test("interruption stops both children and removes signal handlers", async () => {
  const before = process.listenerCount("SIGINT");
  const f = fixture(readyTunnel, "setInterval(() => {}, 1000)", () => {
    setImmediate(() => process.emit("SIGINT"));
  });
  await assert.rejects(runVpsMigration(env, f.start), /Migration interrupted/);
  assertStopped(f.children);
  assert.equal(process.listenerCount("SIGINT"), before);
});
