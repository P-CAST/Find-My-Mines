import { cp, readdir, rm } from "node:fs/promises";

// Next traces server dependencies, but leaves these assets out of standalone output.
await cp("public", "dist/standalone/public", { recursive: true });
await cp("dist/static", "dist/standalone/dist/static", { recursive: true });
await cp("scripts/start-production.js", "dist/standalone/start.js");

// Supply deployment secrets at runtime instead of shipping build-machine env files.
for (const name of await readdir("dist/standalone")) {
  if (name === ".env" || name.startsWith(".env.")) {
    await rm(`dist/standalone/${name}`);
  }
}

console.log(
  "Deploy dist/standalone and run node start.js with runtime environment variables.",
);
