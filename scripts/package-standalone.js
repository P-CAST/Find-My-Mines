import { cp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";

// Next traces server dependencies, but leaves these assets out of standalone output.
await cp("public", "dist/standalone/public", { recursive: true });
await cp("dist/static", "dist/standalone/dist/static", { recursive: true });
await cp("scripts/start-production.js", "dist/standalone/start.js");

// Preserve the public build settings as defaults for a copied deployment.
const { config } = JSON.parse(
  await readFile("dist/required-server-files.json", "utf8"),
);
await writeFile(
  "dist/standalone/production-config.json",
  JSON.stringify({
    ip: config.env.NEXT_PUBLIC_PRODUCTION_IP,
    port: config.env.NEXT_PUBLIC_PRODUCTION_PORT,
  }),
);

// Keep Next's generated server intact, and make the usual entrypoint run our launcher.
await rename("dist/standalone/server.js", "dist/standalone/next-server.js");
await writeFile("dist/standalone/server.js", 'import "./start.js";\n');

// Supply deployment secrets at runtime instead of shipping build-machine env files.
for (const name of await readdir("dist/standalone")) {
  if (name === ".env" || name.startsWith(".env.")) {
    await rm(`dist/standalone/${name}`);
  }
}

console.log(
  "Deploy dist/standalone, supply a runtime .env, and run node server.js.",
);
