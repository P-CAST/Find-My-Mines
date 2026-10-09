import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const readyMarker = "find-my-mines-tunnel-ready";
type StartProcess = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

function port(value: string, name: string) {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(`${name} must be a port between 1 and 65535.`);
  }
  return String(Number(value));
}

export function readVpsConfig(env: NodeJS.ProcessEnv) {
  const target = env.VPS_SSH_TARGET?.trim();
  if (!target || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@:[\]-]*$/.test(target)) {
    throw new Error(
      "Set VPS_SSH_TARGET to user@host or an SSH config alias in .env.",
    );
  }
  let database: URL;
  try {
    database = new URL(env.VPS_DATABASE_URL ?? "");
  } catch {
    throw new Error(
      "Set VPS_DATABASE_URL to the VPS PostgreSQL connection URL in .env.",
    );
  }
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    !database.hostname ||
    database.pathname.length < 2
  ) {
    throw new Error(
      "VPS_DATABASE_URL must specify a PostgreSQL host and database.",
    );
  }
  // Alternate connection destinations could bypass the SSH tunnel.
  for (const key of ["host", "hostaddr", "port", "service"]) {
    if (database.searchParams.has(key)) {
      throw new Error(
        `Remove the ${key} query parameter from VPS_DATABASE_URL.`,
      );
    }
  }
  const localPort = port(env.VPS_TUNNEL_PORT ?? "15432", "VPS_TUNNEL_PORT");
  const sshPort = env.VPS_SSH_PORT
    ? port(env.VPS_SSH_PORT, "VPS_SSH_PORT")
    : undefined;
  const forward = `127.0.0.1:${localPort}:${database.hostname}:${database.port || "5432"}`;
  database.hostname = "127.0.0.1";
  database.port = localPort;
  return { target, sshPort, forward, databaseUrl: database.toString() };
}

class Interrupted extends Error {
  constructor(readonly exitCode: number) {
    super("Migration interrupted.");
  }
}

function track(child: ChildProcess) {
  const done = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
  }>((resolveDone) => {
    child.once("error", (error) =>
      resolveDone({ code: null, signal: null, error }),
    );
    child.once("close", (code, signal) => resolveDone({ code, signal }));
  });
  return { child, done };
}

async function stop(process: ReturnType<typeof track> | undefined) {
  if (!process?.child.pid) return;
  const child = process.child;
  if (child.exitCode !== null || child.signalCode !== null) {
    await process.done;
    return;
  }
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 2000);
  try {
    await process.done;
  } finally {
    clearTimeout(force);
  }
}

export async function runVpsMigration(
  env: NodeJS.ProcessEnv,
  start: StartProcess = spawn,
) {
  const config = readVpsConfig(env);
  let tunnel: ReturnType<typeof track> | undefined;
  let migration: ReturnType<typeof track> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let interrupt!: (error: Error) => void;
  const interrupted = new Promise<never>((_, reject) => {
    interrupt = reject;
  });
  const onInterrupt = () => interrupt(new Interrupted(130));
  const onTerminate = () => interrupt(new Interrupted(143));
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);

  try {
    console.log(`Opening migration tunnel through ${config.target}...`);
    const args = [
      "-T",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ControlMaster=no",
      "-o",
      "ControlPath=none",
      "-o",
      "ForkAfterAuthentication=no",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "ServerAliveInterval=15",
      "-o",
      "ServerAliveCountMax=3",
      ...(config.sshPort ? ["-p", config.sshPort] : []),
      "-L",
      config.forward,
      config.target,
      // SSH runs this only after setting up forwarding. The open stdin keeps
      // cat alive; ending this SSH process also closes the remote command.
      `printf '${readyMarker}\\n'; cat`,
    ];
    tunnel = track(
      start("ssh", args, {
        cwd: projectRoot,
        env,
        stdio: ["pipe", "pipe", "inherit"],
      }),
    );
    const tunnelClosed = tunnel.done.then((result) => {
      throw new Error(
        result.error
          ? `Could not start SSH: ${result.error.message}`
          : "SSH tunnel closed. Check SSH access and whether VPS_TUNNEL_PORT is already occupied.",
      );
    });
    const ready = new Promise<void>((resolveReady, reject) => {
      let output = "";
      tunnel!.child.stdout!.on("data", (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-4096);
        if (output.includes(readyMarker + "\n")) resolveReady();
      });
      timer = setTimeout(
        () =>
          reject(
            new Error("SSH tunnel did not become ready within 60 seconds."),
          ),
        60_000,
      );
    });
    await Promise.race([ready, tunnelClosed, interrupted]);
    clearTimeout(timer);

    console.log("Applying pending migrations to the VPS database...");
    migration = track(
      start(
        process.execPath,
        [resolve(projectRoot, "node_modules/drizzle-kit/bin.cjs"), "migrate"],
        {
          cwd: projectRoot,
          env: { ...env, DATABASE_URL: config.databaseUrl },
          stdio: "inherit",
        },
      ),
    );
    const result = await Promise.race([
      migration.done,
      tunnelClosed,
      interrupted,
    ]);
    if (result.error)
      throw new Error(`Could not start Drizzle: ${result.error.message}`);
    if (result.code !== 0) {
      throw new Error(
        `Drizzle migration failed (${result.signal ?? result.code}).`,
      );
    }
    console.log("VPS migrations complete.");
  } finally {
    clearTimeout(timer);
    await stop(migration);
    await stop(tunnel);
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    try {
      loadEnvFile(resolve(projectRoot, ".env"));
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
    }
    await runVpsMigration(process.env);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "VPS migration failed.",
    );
    process.exitCode = error instanceof Interrupted ? error.exitCode : 1;
  }
}
