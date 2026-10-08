# Find My Mines

A two-player classroom game in the existing T3 app: Next.js App Router, React, TypeScript, tRPC 11, Drizzle/PostgreSQL, Tailwind 4, and DaisyUI 5. Players need only a nickname. The existing Better Auth and post router remain available; gameplay does not read or write the database.

## Install and run

Use Node.js 22.14+ (verified locally with Node 24) and the pinned pnpm version:

```sh
pnpm install --frozen-lockfile
cp .env.example .env # only on a new checkout; preserve your existing .env
pnpm dev
```

`pnpm dev` runs the normal Next.js development server on port 3000, using `.next` for development output. Do not start another server if one is already running. For a persistent classroom deployment, configure the production address below, run `pnpm build` once, then `pnpm start`. Use exactly one application instance. Keep it running for the demonstration. Set the existing `DATABASE_URL` and Better Auth configuration as before; `BETTER_AUTH_SECRET` is required for production. No database migration is needed for this game.

`pnpm build` produces a deployable Node application in `dist/standalone`, including its traced dependencies, public files, compiled browser assets, and public production IP/port defaults. Copy that entire directory to the deployment host; no source checkout or dependency installation is needed there. Production builds use `dist` and leave `.next` untouched. Build-machine `.env` files are removed from the bundle. Create a runtime `.env` beside `server.js` on the VPS with `DATABASE_URL`, `BETTER_AUTH_SECRET`, and `GAME_OPERATOR_PASSWORD`, then run from that directory:

```sh
node server.js
```

The entrypoint loads that `.env` automatically; environment variables already supplied by the host take precedence. To keep the file elsewhere, use `node --env-file=/path/to/deployment.env server.js`. When running from the source checkout, `pnpm start` loads the local `.env` if present. The launcher validates settings and rejects public IP/port overrides that differ from the browser bundle. Deploy on a compatible operating system/architecture with Node.js 22.14+.

Open `/` for players and `/operator` for the dashboard. Use separate browsers, private browser profiles, or separate devices for the two players. Tabs in the same profile share one session and one seat.

## LAN configuration

Set these public variables in `.env` before building for production:

```dotenv
NEXT_PUBLIC_PRODUCTION_IP="192.168.1.50"
NEXT_PUBLIC_PRODUCTION_PORT="3000"
NEXT_PUBLIC_PRODUCTION_DOMAIN=""
```

Use the IPv4 address players reach: the deployment computer's LAN address for a classroom or the VPS public address for an internet deployment. The launcher listens on all IPv4 interfaces (`0.0.0.0`) at the configured port. That listening address in Next.js's terminal output is normal; open the public IP printed by the launcher in your browser. The browser HTTP and SSE links use the public IP/port baked into the bundle, which default to `127.0.0.1:3000` when unset. Never set the public IP to `0.0.0.0`. Development keeps using `localhost:3000`; production settings do not change `pnpm dev`. All players and the operator must open the configured origin, such as `http://192.168.1.50:3000`; they do not enter connection settings in the application. Allow the port through the host firewall. Rebuild after changing either production variable because Next.js embeds public variables in the browser bundle. Requests from another browser origin are rejected.

To use a public domain, set `NEXT_PUBLIC_PRODUCTION_DOMAIN` to a hostname such as `mines.example.com` and point its DNS record to the VPS. Use only the hostname, without a scheme, port, or path. When set, it takes priority over the IP for browser HTTP/SSE connections and the launcher's displayed URL; leave it blank to use the IP. The domain is embedded during `pnpm build` and retained in the copied bundle, so rebuild and redeploy after changing it. Node still listens on all IPv4 interfaces. All browsers must open the configured domain origin.

For a reverse proxy, set `PORT` at runtime to the internal Node listening port while keeping `NEXT_PUBLIC_PRODUCTION_PORT` at the externally reachable port used when building. HTTPS deployments should set `SERVER_PROTOCOL` in `src/lib/game-config.ts` to `https`; cookies then use `Secure`. Binding port 80 directly may produce `EACCES` if the Node process lacks permission; in that case use an authorized service configuration or the VPS's existing reverse proxy.

## Operator setup

Set a private password of at least 16 characters in the server's ignored `.env`:

```dotenv
GAME_OPERATOR_PASSWORD="replace-with-a-long-private-password"
```

Open `/operator` and log in. There is no default password. The operator secret is read only on the server and is never shipped as a browser constant. Login is rate limited, and the signed HTTP-only operator cookie lasts eight hours. Reset, Start, and the client-list subscription enforce authorization on the server. Logging out removes operator authorization. Existing streams are authorized when opened; the dashboard closes its stream on logout. Do not share a logged-in operator browser profile with players.

If a local password was generated during implementation, it is in your existing `.env`. Changing environment variables in a production deployment requires restarting the application, which also clears the game.

## Rules and runtime

The server generates 11 distinct random bombs on a covered 6×6 board. The initial first player is random. Bombs award one point and preserve the original deadline. An empty cell reveals its eight-neighbor count and passes play, without flood fill. Each fresh turn has ten seconds. All 11 bombs must be found to finish; there cannot be a tie. Both players must vote for a rematch; the previous winner then starts on a fresh board with scores reset.

`src/server/api/routers/game.ts` exposes HTTP commands and SSE subscriptions through the existing `/api/trpc/[trpc]` Node route. `src/server/game/service.ts` holds the private board and synchronous transitions. There are no awaits between validation and application of a move. Server timers advance turns without browser requests. Every action checks elapsed deadlines as well, so a delayed timer cannot admit a late selection. Match and turn UUIDs reject stale actions and callbacks; state revisions increase throughout a process lifetime. A process instance UUID lets the browser recover when revisions restart after a server restart.

The service is retained on `globalThis` to avoid duplicate services, timers, or listeners under development module reloads. Both GET subscriptions and POST mutations use the same route and service. The integration script verifies their shared instance ID and observable state, not just the source-code arrangement. Development reloads refresh service methods while preserving the instance. Changes to the shape of its stored fields require a deliberate server restart; ordinary UI and method edits do not. Never restart a user's server automatically.

**Single-process limitation:** `globalThis` is not shared across processes or workers. Run one persistent Next.js Node application serving this route, with no cluster mode, extra replicas, serverless functions, separate game worker, or load-balanced instances. Restarting it loses the active match, sessions, scores, votes, and operator cookies. This is intentionally an in-memory single-match demo; Drizzle remains in place for existing app functionality. If multi-process deployment becomes necessary, game authority must move to transaction-safe storage rather than relying on this singleton.

## Streaming, timing, and disconnects

- The browser first obtains a server-issued, signed HTTP-only session cookie. Only the server verifies this credential; a public session UUID never authorizes actions. HTTP and EventSource send the same cookie. Nicknames are not credentials.
- `splitLink` uses `httpSubscriptionLink` for SSE and preserves `httpBatchStreamLink` for ordinary requests. Session bootstrap and operator login/logout use `httpLink`: those responses must finish setting cookies before headers are sent. SuperJSON and existing Better Auth configuration are preserved.
- Each subscription attaches its listener before reading the initial snapshot. Reconnection sends the latest full state. Slow consumers coalesce pending updates. The browser ignores older revisions. Covered cells carry only `{ kind: "covered" }`, including at results; hidden bomb positions are never serialized.
- SSE pings every three seconds; the client reconnects after seven seconds without stream activity. Responses disable caching/transformation and request unbuffered proxy delivery (`X-Accel-Buffering: no`). A reverse proxy must support streaming and must not buffer SSE responses.
- Server timestamps and deadlines drive the displayed countdown. A five-second HTTP heartbeat measures clock offset using the request midpoint; the countdown itself is local display work and does not broadcast ticks. The server is authoritative even if a client clock or network delay is inaccurate.
- Presence counts **unique sessions with game-state SSE streams**, including visitors marked “Not joined.” Streams are reference-counted across tabs. Operator-only subscriptions do not count. The terminal logs safe public IDs/nicknames and the count when presence or names change; it never logs cookie credentials.
- A five-second client heartbeat renews a **15-second presence lease** while the state subscription is connected. Normal stream closure removes that stream immediately. Missing heartbeats expire the entire session's presence and clean up its streams/listeners, even if an abruptly broken connection has not closed. A background tab whose timers are heavily throttled can also lose its lease; keep game pages visible during the demo. Physical disconnection is not detected instantaneously.
- After the last stream closes or the lease expires, a player's seat is reserved for **15 more seconds**. Returning with the same cookie within that grace period restores the seat. Match timers continue during grace. After grace, the match is aborted, its timer canceled, scores/votes/results cleared, and the missing seat released. The remaining player returns to the lobby without an artificial win. A replacement can join and start a new initial match.
- Reset invalidates the board, match and turn IDs, timer, scores, result, and votes. It retains connected seats, releases disconnected seats, and enters a manual-start lobby. Start requires two connected players. Initial joins and mutually agreed rematches start automatically.

## Checks and demonstration

```sh
pnpm check             # ESLint, TypeScript, deterministic game tests
pnpm test:integration  # real HTTP + SSE against the already-running, empty server
```

The integration check reads the operator password from `.env` (or the environment). It refuses an occupied lobby, creates its own sessions, exercises gameplay, reconnection, duplicate tabs, operator reset/start, and the presence lease/grace period, then releases its seats. It takes about a minute. It starts no server. Use `GAME_TEST_ORIGIN` to target another configured host. It waits for its disconnected seats to be released, leaving an empty lobby that starts automatically when two players join.

Demo checklist:

1. Open the player URL in two independent browser sessions; open `/operator` in a third.
2. Join with two nicknames; confirm both boards/scores agree and both welcome messages appear. Confirm a third session cannot take a seat.
3. Select cells: bombs preserve time, empty cells pass play. Wait without clicking and observe a server-driven turn change in both browsers.
4. Finish finding 11 bombs; confirm Win/Lost, scores, two votes, and winner-first rematch.
5. Disconnect one player briefly and reconnect; confirm seat and state recover. Disconnect longer than lease plus grace (up to about 30 seconds) and confirm lobby return without a winner.
6. Check unique-session presence and safe identifiers in the dashboard and server terminal. Extra tabs for the same session count once.
7. Reset with confirmation; confirm an empty board and scores, retained connected seats, and working Start. An ordinary player calling operator procedures must be rejected.

**Assignment wording:** this implementation deliberately uses HTTP mutations plus SSE subscriptions. Confirm with the instructor that this meets the assignment's “socket programming” requirement. SSE is an HTTP streaming mechanism; this project does not demonstrate raw TCP/UDP socket programming.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for project conventions. The subscription transport follows [tRPC's subscription documentation](https://trpc.io/docs/server/subscriptions).
