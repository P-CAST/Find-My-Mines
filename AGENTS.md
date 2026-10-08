# Find My Mines contributor instructions

Preserve the existing Next.js App Router, tRPC, Drizzle/PostgreSQL, and stable dependency versions. Do not introduce Prisma, Pages Router, canary packages, or additional infrastructure.

## Development server

Use the user's already-running development server for testing whenever possible so the user can see its logs in their own terminal. Do not stop, restart, replace, or interfere with that server or any process listening on port 3000. Do not start a duplicate server through internal terminal tooling when the existing server can serve the same purpose.

If the user is already running a development server and a separate development server is genuinely necessary, run it only on port not in use. Keep it isolated from the user's server, including the single game worker and its database ownership lock; if isolation cannot be guaranteed, do not start it. Track the exact process you start and stop it before finishing the task, including after failures or interrupted checks. Never leave an internally started development server running or make the user find and kill its PID.

## Game architecture and interface

Keep game procedures in `src/server/api/routers/game.ts`, with one synchronous in-memory authority used by the existing Node tRPC route. Commands use HTTP; live state uses tRPC SSE. Retain SuperJSON, Better Auth, and Drizzle functionality. Never serialize hidden bombs or accept a public player ID as authorization. Use signed HTTP-only session cookies and enforce operator permissions on the server. Maintain match/turn IDs, increasing revisions, server timers, stream cleanup, and session-level presence leases. This deployment is single-process; restarting clears the match. Changes to stored service fields require a deliberate user-managed restart because development reloads retain the authority.

Use native JSX with DaisyUI 5 directly, Tailwind 4 for layout, and the fixed built-in `corporate` light theme. Reuse `PageShell`, `Panel`, `PlayerScore`, `GameCell`, `TurnTimer`, and `ConnectionStatus`. Use primary buttons for Join/Rematch/Start, default for secondary/Cancel, error for Reset. Use semantic theme colors, accessible text/symbol state indicators, visible focus, and legible disabled revealed cells. Avoid UI wrapper libraries, custom palettes/CSS, and generic design-system layers.

Run `pnpm check` for lint, type checking, and game tests. Use `pnpm test:integration` only against an empty lobby on the existing server. Preserve the running development output when verifying production builds. See `CONTRIBUTING.md` and `README.md` for setup, protocol, and demonstration conventions.
