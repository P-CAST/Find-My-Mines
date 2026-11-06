import { readFileSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import {
  assertInternalPortFree,
  createTlsForwarder,
  loadTls,
  productionSettings,
  waitForInternalServer,
} from "./production-https.js";

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
const settings = productionSettings(defaults, process.env);

if (!settings.internalPort) {
  // Existing HTTP deployments, including those behind an external proxy.
  process.env.HOSTNAME = "0.0.0.0";
  process.env.PORT = String(settings.port);
  console.log(
    `Find My Mines: open ${settings.origin} (server port ${settings.port}).`,
  );
  await import(new URL("./next-server.js", import.meta.url).href);
} else {
  if (!settings.certPath || !settings.keyPath)
    throw new Error("Missing TLS paths.");
  const tls = loadTls(import.meta.dirname, settings.certPath, settings.keyPath);
  await assertInternalPortFree(settings.internalPort);
  const forwarder = createTlsForwarder(tls, settings.internalPort);
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
    forwarder.close();
    // Next keeps its own signal handlers. Bound cleanup even for stalled requests.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("exit", forwarder.close);
  try {
    process.env.HOSTNAME = "127.0.0.1";
    process.env.PORT = String(settings.internalPort);
    await import(new URL("./next-server.js", import.meta.url).href);
    await waitForInternalServer(settings.internalPort, controller.signal);
    controller.signal.throwIfAborted();
    await new Promise((resolve, reject) => {
      forwarder.server.once("error", reject);
      forwarder.server.listen(settings.port, "0.0.0.0", () =>
        resolve(undefined),
      );
    });
    forwarder.server.on("error", (error) => {
      console.error("HTTPS listener failed:", error);
      forwarder.close();
      process.exit(1);
    });
    console.log(
      `Find My Mines: open ${settings.origin} (HTTPS port ${settings.port}; internal port ${settings.internalPort}).`,
    );
  } catch (error) {
    forwarder.close();
    if (!controller.signal.aborted)
      console.error("HTTPS startup failed:", error);
    process.exit(controller.signal.aborted ? 0 : 1);
  }
}
