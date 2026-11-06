# Find My Mines

A two-player classroom game in the existing T3 app: Next.js App Router, React, TypeScript, tRPC 11, Drizzle/PostgreSQL, Tailwind 4, and DaisyUI 5. Players can use accounts or guest nicknames. Independent two-player rooms share one in-memory authority. Games between two accounts save results and replays in PostgreSQL; games involving a guest never create game records. Better Auth and the post router remain available.

## Install and run

Use Node.js 22.14+ (verified locally with Node 24) and the pinned pnpm version:

```sh
pnpm install --frozen-lockfile
cp .env.example .env # only on a new checkout; preserve your existing .env
pnpm dev
```

`pnpm dev` runs the normal Next.js development server on port 3000, using `.next` for development output. Do not start another server if one is already running. For a persistent classroom deployment, configure the production address below, run `pnpm build` once, then `pnpm start`. Use exactly one application instance. Keep it running for the demonstration. Set the existing `DATABASE_URL` and Better Auth configuration as before; `BETTER_AUTH_SECRET` is required for production. Apply the checked-in Drizzle migrations with `pnpm db:migrate` before using account history and replays. The room/history update adds two tables and requires a deliberate user-managed application restart because the in-memory service shape changed.

`pnpm build` produces a deployable Node application in `dist/standalone`, including its traced dependencies, public files, compiled browser assets, and public production address/protocol defaults. Copy that entire directory to the deployment host; no source checkout or dependency installation is needed there. Production builds use `dist` and leave `.next` untouched. Build-machine `.env` files are removed from the bundle. Create a runtime `.env` beside `server.js` on the VPS with `DATABASE_URL` and `BETTER_AUTH_SECRET`, then run from that directory:

```sh
node server.js
```

The entrypoint loads that `.env` automatically; environment variables already supplied by the host take precedence. To keep the file elsewhere, use `node --env-file=/path/to/deployment.env server.js`. When running from the source checkout, `pnpm start` loads the local `.env` if present. The launcher validates settings and rejects public address/protocol overrides that differ from the browser bundle. Deploy on a compatible operating system/architecture with Node.js 22.14+.

Open `/` for the homepage, `/game` for rooms and matchmaking, `/game/history` for your results and replays, and `/operator` for the dashboard. Play as a guest or use the homepage Login tab to sign in or create an account. Registration asks for a name, email, and password (8–128 characters), signs you in, and opens the lobby. Guests choose a name on the homepage before entering a game; it stays fixed for the 24-hour browser guest session and is used in both games and global messages. Direct lobby or room links send unnamed guests to the homepage, then return them to their destination. Signed-in players use their account name automatically. Returning users see a welcome card; the navigation drawer shows the signed-in account and Logout.

Accounts use Better Auth's HTTP-only session cookies and the existing PostgreSQL `user`, `account`, `session`, and `verification` tables. Configure `DATABASE_URL` and `BETTER_AUTH_SECRET`; Better Auth uses the same canonical origin as the game. For a fresh database, apply the existing Drizzle migrations with `pnpm db:migrate` before using accounts. Do not reapply the initial migration to a database already created with `db:push` without reconciling its migration history. Game profiles and saved results use the additional `pg-drizzle_game_profile` and `pg-drizzle_game_result` tables. Email verification, password recovery, and social login are not configured.

Account seats belong to the verified Better Auth account across browsers and devices. Guests own seats through signed HTTP-only game cookies. One identity can occupy one room or one matchmaking queue entry at a time; an account cannot play against itself. Account changes never transfer an existing seat. Closing or changing the account's last room connection starts the normal reconnect grace period. Only accounts with the Better Auth `admin` role grant operator permissions.

## Play with bot

Guests and signed-in players can use **Play with bot** in the lobby. Configure
`OPENAI_BOT_MODEL` with a Responses-compatible model that supports strict structured
outputs, alongside the existing server-only `OPENAI_API_KEY`. Analysis continues
using its separate `OPENAI_ANALYSIS_MODEL` setting. No database migration is needed.

Bot games are unlisted practice rooms with a spectator link, normal 10-second
turns, and automatic bot rematch acceptance. They never save results, replays, or
analysis. The bot sees only public cells, clues, anonymous scores, and remaining
time, with a labeled grid, cell coordinates, legal moves, and explicit visible
neighbors for each clue. The prompt explains bomb counting and overlapping clues
and provides hypothetical deduction examples; the model performs all deductions.
It cannot see hidden bombs or read the message board. OpenAI requests use
`store: false` (this does not disable all provider retention).

The server allows **three bot games total per rolling hour**, shared by all
guests and accounts. Creating a room, accepting a rematch, or starting again after
an operator reset consumes a slot. Duplicate creation requests and rejected
actions do not; leaving or abandoning a game does not refund it. The lobby shows
remaining slots and when the next slot becomes available. The quota is in memory
and resets on a server restart.

Requests start immediately after the game transition and may use all time remaining
in the normal 10-second turn, with no retries and at most 36 API calls per match.
Finding a bomb keeps the original deadline; the next request gets only the remaining
time. Responses are applied as soon as they arrive. At the deadline, pending work
is canceled and play passes normally, without revealing a fallback cell. API errors
or invalid responses received before the deadline use a random covered cell and
display a fallback notice. Disconnecting cancels pending work; timers and normal
reconnect grace continue. The bot room closes when its human leaves or their
reservation expires.

The bot update introduced retained game authority runtime version 3; the friends
update below requires version 4. After
existing games end, the server owner must deliberately restart the application
to load the new fields and environment setting. Development reloads never replace
the old authority automatically. Automated bot tests mock OpenAI; verify the
chosen model's latency and structured-output support in a configured practice
game before deployment.

## Rooms, matchmaking, history and replays

- Create a public room, listed in the lobby, or an invite-only room, accessible to anyone with its unlisted link. Share `/game/<roomId>` to invite an opponent or spectator. Public rooms can be watched from the lobby. Initial matches start when both seated players are connected to the room.
- Find opponent matches accounts with accounts and guests with guests, FIFO within each group. After an account has waited 30 seconds, a waiting guest may be paired with it. Automatic matches create unlisted rooms and reserve seats for 15 seconds while players open the room. Cancel matchmaking before manually joining or creating another room.
- Lobby streams keep queue entries present; only streams for the actual room keep a player connected there. Opening the lobby alone cannot prevent a room forfeit. Empty rooms and their timers/subscriptions are cleaned up; account history is independent of room lifetime.
- Two account players record the match from its start. Normal completion and forfeits save a result and replay together, once per match ID. Rematches have new IDs and separate recordings. Operator-canceled matches and matches abandoned by both disconnected players have no result. Guest or mixed matches never reach database persistence, even if a guest later signs in.
- Replays record ordered public states for the start, reveals, server timeouts, player connection changes, and terminal result. Playback offers play/pause, previous/next events, seeking, and 1×/2×/4× speed. Hidden bomb layouts, account/session credentials, heartbeat ticks, and unrevealed cells are never included in replay data. A forfeit replay keeps unrevealed cells covered.
- History is private by default. Change **Allow public history and replays** in My history to share your profile link. Participants can always view their own saved matches. Other visitors can view a result or replay only while **both players** allow public history. Privacy is checked by the server for listings and direct replay URLs. Visibility changes affect subsequent requests; they cannot retract data someone already viewed.
- Saving runs outside synchronous game transitions. Results and replays are written atomically and retried every five seconds on failure, using match IDs to prevent duplicates. Players see pending/failed save status; the operator sees pending/failed totals. Pending writes survive room disposal but remain in memory until saved: a process crash or restart can lose unsaved records. Successfully saved records and preferences survive restarts.

### AI replay analysis

A saved replay has an AI game analysis panel. A signed-in match participant can generate a report; everyone allowed to view that replay can read the saved report. Public access still requires both participants to allow public history. Revoking public history also revokes access to its analysis. Reports are shared between the participants and saved once per match and analysis version, without a regeneration button.

To enable generation, apply the additive migration with `pnpm db:migrate`, then set both server-only values in `.env`:

```dotenv
OPENAI_API_KEY="your-api-key"
OPENAI_ANALYSIS_MODEL="your-responses-compatible-model"
```

Choose a model available to your OpenAI project that supports Responses API structured outputs. Restart the server yourself when changing environment configuration. Missing values disable generation without preventing access to saved reports. Deployment order is migration first, application update second, then enable configuration. No replay backfill is required.

Generation sends anonymized public replay events to OpenAI with `store: false`; it excludes player names, account/session identifiers, chat, and hidden bomb layouts. This setting disables Responses storage, not all provider retention policies. Reports contain server-calculated statistics, an AI summary, event links, and coaching for both players. Coaching does not establish optimal play or exact probabilities and can be inaccurate. Selecting an event pauses playback and seeks to that moment.

Requests use the existing HTTP route, separate from live-game transitions. Limits are two concurrent requests across the process and five new attempts per account per hour, including failed attempts; cached reads and deduplicated requests do not consume additional attempts. Requests time out after 60 seconds, output is capped at 8,000 tokens, and evidence exceeding 64 KiB is rejected without truncation. Failures can be retried manually. In-memory concurrency and rate limits survive development reloads but reset on process restart; completed reports persist in PostgreSQL. Logs contain duration, token usage, cache hits, and sanitized error categories, never provider payloads or keys.

`pnpm check` tests provider behavior using mocks and incurs no OpenAI charges. The opt-in PostgreSQL history test also checks report persistence, uniqueness, permissions, and cascading deletion using rolled-back temporary tables. A real provider smoke test requires the two settings above and one explicit Analyze game action on a participant's replay.

## Friends and invitations

Signed-in accounts can open **Friends** from navigation. Search all account names (at least two characters), send requests, and accept,
decline, cancel, or remove connections. A short public profile ID distinguishes
players with duplicate names. Emails, credentials, and private histories are never
included in search. Friends and requests are private to the participants;
friendship does not change either player's history/replay privacy settings.

Accepted friends see online/offline status while the other account has any active
signed-in app tab. Social connections have independent 15-second leases renewed
every five seconds and aggregate across tabs and devices. They never keep a game
seat connected. Losing the last connection, session expiry, or logout removes
social presence after stream cleanup/lease expiry. Persisted sessions are checked
again every ten seconds on long-lived streams.

Use **Invite to game** for an online friend. Both accounts must be out of rooms and
matchmaking. One pending invitation may involve each account; it expires after
60 seconds. Accepting automatically opens an unlisted room in both players'
connected tabs, reserves both seats for 15 seconds, and starts only when both
connect to that room. A visitor with the link can watch but cannot take a reserved
seat, even after its owner fails to arrive. Normal timers, forfeits, rematches,
and account-game recording apply. Entering another game or queue, removing the
friendship, declining, or canceling invalidates pending invitations.

Limits are 30 searches, ten new friend requests, and five new game invitations
per account per rolling minute. Declining/canceling a request or invitation, or
removing a friend, adds a 60-second cooldown before that pair can retry the same
kind of request. Blocking, direct messages, and email/push notifications are not
included.

Deploy by applying `pnpm db:migrate` before using the updated application. Migration
`0002_stormy_spitfire.sql` adds the friendship table and creates public profile IDs
for existing accounts without changing history consent. No new environment values
are needed. After existing games and pending saves finish, the server owner must
**deliberately restart the application** to load authority runtime version 4.
Development reloads do not replace the old authority. Friendships and requests
persist; live rooms, social presence, invitations, and rate limits reset on restart.

Verify with `pnpm check` and the opt-in rolled-back PostgreSQL checks:

```sh
GAME_TEST_DATABASE=1 pnpm exec tsx --env-file=.env --test tests/friends.test.ts
```

For a manual check, use two accounts in separate browser sessions. Search a name,
accept a request, verify presence across multiple tabs, send an invitation, and
confirm both accounts navigate into the same game. Verify an unrelated account can
only spectate and that viewing Friends cannot prevent a disconnected room forfeit.

## Global message board

The lobby and every room share one global message board. Guests, signed-in accounts, and spectators can read and post. The server labels account messages with the signed-in account name and guests with the name chosen on the homepage, verified through a signed, HTTP-only cookie bound to their browser game session. Posting requires a guest name or a signed-in account; message requests cannot override the author name. Messages are visible across all rooms, including invite-only rooms; room IDs and invite links are never added automatically. The lobby places the board beside Play a game, with Public rooms below both. In rooms, it sits below Players; the rules are a small footnote beneath the game.

The server retains only the latest 100 messages in memory. They survive ordinary development reloads but disappear on application restart. Messages are plain text, limited to 500 characters. The compact card has a left-aligned heading, a scrolling conversation, and a single-line input beside Send. Posting is limited to one message every two seconds and ten per rolling minute per account (across devices), or per signed browser session for guests. This version has no deletion or mute controls. Enter sends (except while composing with an IME). Sending failures preserve the draft for manual retry.

Messaging HTTP mutations and SSE subscriptions use the dedicated `/api/messages/[trpc]` Node route (`messages.send({ text })` and `messages.onBoard`). Author names are assigned by the server; client-supplied author fields are rejected. Game procedures remain on `/api/trpc/[trpc]`; neither endpoint exposes the other procedure set. Both use the existing cookie authentication, origin checks, SuperJSON, and SSE anti-buffering settings. Messaging has independent revisions, connection status, reconnection, and listener cleanup. Messaging streams do not count toward game presence or renew room/queue leases, and messages never enter saved match results or replays. No new environment settings or database migrations are needed.

The messaging service is retained on `globalThis` separately from the game authority. Future incompatible changes to its stored fields must increment its runtime version and require a deliberate user-managed restart; never restart an active server automatically.

## Apply database migrations to the VPS

For SCP deployments of `dist/standalone`, run migrations from your local source checkout through SSH:

```sh
pnpm db:migrate:vps
```

First configure these private helper variables in your local `.env`:

```dotenv
VPS_SSH_TARGET="deploy@your-vps"
VPS_DATABASE_URL="postgresql://DB_USER:DB_PASSWORD@127.0.0.1:5432/find_my_mines"
VPS_SSH_PORT=""
VPS_TUNNEL_PORT="15432"
```

Use the VPS database credentials and the PostgreSQL host/port reachable from the VPS. The database must already exist. URL-encode special characters in credentials. `VPS_SSH_TARGET` also accepts an alias from `~/.ssh/config`; SSH uses your usual keys, agent, or password prompt. Leave `VPS_SSH_PORT` empty to use your SSH configuration. Change `VPS_TUNNEL_PORT` if that local port is occupied.

The command waits for SSH to establish forwarding, applies pending files from `drizzle/` with the existing Drizzle configuration, and closes its tunnel on success, failure, or Ctrl+C. It supplies the tunnel URL only to the migration process; your local `DATABASE_URL` keeps its existing value. It does not deploy or restart the app. No migration tooling is needed in the copied standalone directory.

For schema changes, run `pnpm db:generate`, review and commit the generated `drizzle/` files, then run `pnpm db:migrate:vps` before deploying code that requires them. Changes applied while the old app is running must remain compatible with that release. An existing database created with `db:push` needs its schema and migration history reconciled before applying an initial migration that creates those same tables.

These helpers belong only in your local `.env`. The VPS runtime `DATABASE_URL` should continue to use the database address reachable directly from the VPS.

## LAN configuration

Set these public variables in `.env` before building for production:

```dotenv
NEXT_PUBLIC_PRODUCTION_IP="192.168.1.50"
NEXT_PUBLIC_PRODUCTION_PORT="3000"
NEXT_PUBLIC_PRODUCTION_DOMAIN=""
```

Use the IPv4 address players reach: the deployment computer's LAN address for a classroom or the VPS public address for an internet deployment. The launcher listens on all IPv4 interfaces (`0.0.0.0`) at the configured port. That listening address in Next.js's terminal output is normal; open the public IP printed by the launcher in your browser. The browser HTTP and SSE links use the public IP/port baked into the bundle, which default to `127.0.0.1:3000` when unset. Never set the public IP to `0.0.0.0`. Development keeps using `localhost:3000`; production settings do not change `pnpm dev`. All players and the operator must open the configured origin, such as `http://192.168.1.50:3000`; they do not enter connection settings in the application. Allow the port through the host firewall. Rebuild after changing any public production variable because Next.js embeds public variables in the browser bundle. Requests from another browser origin are rejected.

To use a public domain, set `NEXT_PUBLIC_PRODUCTION_DOMAIN` to a hostname such as `mines.example.com` and point its DNS record to the VPS. Use only the hostname, without a scheme, port, or path. When set, it takes priority over the IP for browser HTTP/SSE connections and the launcher's displayed URL; leave it blank to use the IP. The domain is embedded during `pnpm build` and retained in the copied bundle, so rebuild and redeploy after changing it. Node still listens on all IPv4 interfaces. All browsers must open the configured domain origin.

For a reverse proxy, set `PORT` at runtime to the internal Node listening port while keeping `NEXT_PUBLIC_PRODUCTION_PORT` at the externally reachable port used when building. HTTPS deployments should build with `NEXT_PUBLIC_PRODUCTION_PROTOCOL="https"`; keep the proxy’s public `Host` and forward `X-Forwarded-Proto: https` so origin checks and secure cookies work. Disable response buffering and allow long-lived SSE connections. Binding port 80 directly may produce `EACCES` if the Node process lacks permission; in that case use an authorized service configuration or the VPS's existing reverse proxy.

## Direct HTTPS standalone deployment

The standalone launcher can serve HTTPS itself, with no separate proxy service.
It uses Node’s built-in HTTPS server to stream requests to the generated Next HTTP
server on loopback in the same process. Keep exactly one application instance.

Before `pnpm build`, configure the public origin in your local `.env`:

```dotenv
NEXT_PUBLIC_PRODUCTION_DOMAIN="netcentric.chayatornounpat.com"
NEXT_PUBLIC_PRODUCTION_IP="149.28.158.35"
NEXT_PUBLIC_PRODUCTION_PORT="443"
NEXT_PUBLIC_PRODUCTION_PROTOCOL="https"
```

Point the domain’s DNS to the VPS. Copy the entire `dist/standalone` folder as
usual. In the VPS `.env` beside `server.js`, keep your existing `DATABASE_URL` and
`BETTER_AUTH_SECRET`, and add:

```dotenv
TLS_CERT_PATH="/etc/ssl/find-my-mines/fullchain.pem"
TLS_KEY_PATH="/etc/ssl/find-my-mines/privkey.pem"
TLS_INTERNAL_PORT="3001"
```

Run `node server.js`. Open `https://netcentric.chayatornounpat.com`. The launcher
listens publicly on port 443 and Next listens only on `127.0.0.1:3001`. Choose a
free internal port; do not use the running development server’s port. `PORT`, if
set, overrides the HTTPS listener port without changing the baked-in public URL
(useful for external port mappings). The two listening ports must differ.

Supply both PEM paths together. Relative paths resolve beside `server.js`, not
against the shell’s working directory. The certificate must include the full
chain and cover your domain; clients must trust its issuer. The private key must
match it. Missing/unreadable files and invalid TLS material fail startup; the
launcher never silently falls back to HTTP. Certificate paths are runtime-only;
they are not embedded in browser assets or production-config.json. Keep the
certificate and private key outside the deployment bundle and source checkout.

Manage certificate issuance and renewal separately. Give the service account
read access to the private key and permission to bind port 443 through your host’s
service configuration, without running Node as root. Allow public TCP port 443.
No port-80 redirect listener or certificate automation is included.

After renewal, drain games and pending saves and deliberately restart the app to
load the replacement files; restarting clears live rooms and unsaved state.
SIGINT/SIGTERM also close HTTPS streams so Next can shut down, with a five-second
upper bound for termination. Rebuilding is only required when the public
address, port, or protocol changes.

The HTTPS tests in `pnpm check` use `openssl` to generate temporary local test
certificates; no certificate files are committed or deployed.

Without TLS paths the launcher retains its HTTP behavior, including deployments
behind an external HTTPS proxy. Public protocol defaults to `http`; `pnpm dev`
continues using HTTP on port 3000 regardless of production settings.

## Operator setup

Operators use ordinary Better Auth email/password login. Only accounts with the
`admin` role can open `/operator`, inspect rooms, Reset, or Start. Ordinary accounts
and guests do not see its navigation entry. Direct unauthenticated visits return
to homepage login and then the dashboard; signed-in non-administrators receive a
not-found page. The dashboard retains room-specific controls and confirmations.
Account logout in the navigation drawer also logs the operator out.

Apply migrations `0005_better_auth_admin` and `0006_seed_operator` with
`pnpm db:migrate` (or `pnpm db:migrate:vps`) before activating the updated app.
Existing users remain ordinary users. The seed creates `admin@example.com` as
one Operator user, its
Better Auth credential account, and its game profile. Its email and password hash
are in the seed migration; the generated plaintext password is delivered locally
in the ignored, owner-readable `.env.operator.local`, which must not be deployed
or committed. Every database applying this seed gets the same initial login;
change the password through Better Auth's change-password API for independent
deployments. Re-running migrations does not reset the password. An existing seed
email causes a migration error rather than promoting or overwriting that account.

The Better Auth Admin plugin supplies account roles and administrative APIs;
this change adds no user-management UI. Role changes can be made through its
server-authorized APIs. New registrations cannot assign themselves a role.
Operator commands check persisted authorization, and live subscriptions check
before each delivery and every five seconds while idle. Logout, session expiry
or revocation, bans, and role removal terminate privileged streams. Database
validation failures also stop delivery. Operator streams never establish player
presence.

The old shared password and operator cookies no longer authorize anything.
Remove `GAME_OPERATOR_PASSWORD` from deployment configuration. Keep the running
development server under its owner's control; production activation/restarts
must be scheduled after draining live games and pending saves.

## Rules and runtime

The server samples 11 distinct random bombs on a covered 6×6 board, rejecting any candidate with a fully mined 2×2 area, an eight-neighbor connected mine group larger than five, or fewer than three or more than eight mines in any of the top, bottom, left, or right halves. It tries at most 1,000 candidates and reports generation failure if none pass; it never uses an invalid fallback. The initial first player is random. Bombs award one point and preserve the original deadline. An empty cell reveals its eight-neighbor count and passes play, without flood fill. Each fresh turn has ten seconds. All 11 bombs must be found to finish; there cannot be a tie. Both players must vote for a rematch; the previous winner then starts on a fresh board with scores reset.

`src/server/api/routers/game.ts` exposes HTTP commands and SSE subscriptions through the existing `/api/trpc/[trpc]` Node route. `src/server/game/service.ts` holds the private board and synchronous transitions. There are no awaits between validation and application of a move. Server timers advance turns without browser requests. Every action checks elapsed deadlines as well, so a delayed timer cannot admit a late selection. Match and turn UUIDs reject stale actions and callbacks; room updates use increasing process revisions; browsers compare revisions within each subscription scope. Each room owns its board, match/turn IDs, deadlines, and timers. A process instance UUID lets the browser recover when revisions restart after a server restart.

The service is retained on `globalThis` to avoid duplicate services, timers, or listeners under development module reloads. Both GET subscriptions and POST mutations use the same route and service. The integration script verifies their shared instance ID and observable state, not just the source-code arrangement. Development reloads refresh service methods while preserving the instance. Changes to the shape of its stored fields require a deliberate server restart; ordinary UI and method edits do not. An incompatible retained service returns a clear restart-required error instead of reinterpreting its state or creating a second authority. Never restart a user's server automatically.

**Single-process limitation:** `globalThis` is not shared across processes or workers. Run one persistent Next.js Node application serving this route, with no cluster mode, extra replicas, serverless functions, separate game worker, or load-balanced instances. Restarting it loses live rooms, queue entries, game sessions, scores, votes, and unsaved result retries. Saved account results, replays, and privacy preferences remain in PostgreSQL. This is an in-memory multi-room deployment with persistent completed account history. If multi-process deployment becomes necessary, game authority must move to transaction-safe storage rather than relying on this singleton.

## Streaming, timing, and disconnects

- The browser first obtains a server-issued, signed HTTP-only session cookie. Only the server verifies this credential; a public session UUID never authorizes actions. HTTP and EventSource send the same cookie. Nicknames are not credentials.
- `splitLink` uses `httpSubscriptionLink` for SSE and preserves `httpBatchStreamLink` for ordinary requests. Session bootstrap uses `httpLink`: those responses must finish setting cookies before headers are sent. Account login/logout uses the existing Better Auth HTTP route. SuperJSON and existing Better Auth configuration are preserved.
- Each subscription attaches its listener before reading the initial snapshot. Reconnection sends the latest full state. Slow consumers coalesce pending updates. The browser ignores older revisions. Covered cells carry only `{ kind: "covered" }`, including at results; hidden bomb positions are never serialized.
- SSE pings every three seconds; the client reconnects after seven seconds without stream activity. Responses disable caching/transformation and request unbuffered proxy delivery (`X-Accel-Buffering: no`). A reverse proxy must support streaming and must not buffer SSE responses.
- Server timestamps and deadlines drive the displayed countdown. A five-second HTTP heartbeat measures clock offset using the request midpoint; the countdown itself is local display work and does not broadcast ticks. The server is authoritative even if a client clock or network delay is inaccurate.
- Presence counts **unique browser game sessions with lobby or room SSE streams**, including visitors marked “Not joined.” Streams are reference-counted across tabs. Multiple authenticated sessions can keep the same account seat connected; a seat is disconnected only when its last room connection is lost. Operator-only subscriptions do not count. The terminal logs safe public IDs/nicknames and the count when presence or names change; it never logs cookie credentials.
- A five-second client heartbeat renews a **15-second presence lease** while the room or lobby subscription is connected. Normal stream closure removes that stream immediately. Heartbeats renew only that session's streams for the current room or lobby. Missing room heartbeats expire those streams/listeners even if another lobby tab is still connected; the session disappears from presence once all of its streams expire. A background tab whose timers are heavily throttled can also lose its lease; keep game pages visible during the demo. Physical disconnection is not detected instantaneously.
- After the last stream closes or the lease expires, a player's seat is reserved for **15 more seconds**. Returning with the same cookie within that grace period restores the seat. Match timers continue during grace. After grace during active play, a connected opponent wins by forfeit and the missing seat is released. If both players are disconnected, the match is aborted without a winner or record. Explicit Leave during active play awards the opponent a forfeit immediately. Finished results cannot produce another forfeit. Forfeits offer Return to lobby; normally completed matches retain two-party rematches.
- Reset applies only to the selected room and invalidates the current board, match and turn IDs, timer, scores, result, and votes. It cancels active recording without creating a result and never removes previously saved history. It retains connected seats, releases disconnected seats, and enters a manual-start lobby. Start requires two connected players. Initial joins and mutually agreed rematches start automatically.

## Checks and demonstration

```sh
pnpm check             # ESLint, TypeScript, deterministic game tests
pnpm test:integration  # real HTTP + SSE against the already-running, empty lobby
GAME_TEST_DATABASE=1 pnpm exec tsx --env-file=.env --test tests/history.test.ts
```

The integration check also verifies separate messaging routes, global message fanout/history, posting limits, and that messaging streams cannot keep room seats connected. It posts a labeled test message to the temporary board. The integration check signs in using `GAME_TEST_ADMIN_EMAIL` and `GAME_TEST_ADMIN_PASSWORD` from the environment, `.env`, or the private `.env.operator.local` file. It requires an existing administrator and never creates or promotes accounts. It refuses existing rooms or queue entries, then creates two guest rooms and verifies HTTP/SSE isolation, autonomous timers, reconnects, duplicate tabs, operator reset/start, and lease-expiry forfeits. It starts no server and cleans up only its own seats/streams. Use `GAME_TEST_ORIGIN` to target another configured host. After upgrading a retained development service, its owner must restart it before this check can run.

The opt-in PostgreSQL test uses temporary tables inside a rolled-back transaction. It verifies the new migration, idempotent result/replay storage, private defaults, both-player public consent, direct replay authorization, and pagination without modifying account data or persistent game tables. Ordinary `pnpm check` runs deterministic game, room, replay, session, and migration-helper tests without requiring a database connection.

Demo checklist:

1. Create two rooms using four independent identities; verify both matches run simultaneously and moves/reset in one do not change the other.
2. Queue two accounts and verify preferential pairing; queue an account and a guest and verify mixed pairing after 30 seconds with an unrecorded label.
3. Join the same account from a second device; verify it resumes the same seat and cannot occupy another room or queue entry.
4. Complete an account game and watch its replay from My history. Check scores, timeouts, seeking, and winner-first rematch recordings.
5. Leave or disconnect one player beyond grace and verify a forfeit. Disconnect both and verify no saved winner. Guest and mixed matches must never appear in database history.
6. Change both players' history settings and check their public history/replay URLs from a separate guest browser. Making either account private must block subsequent public replay requests.
7. Inspect room selection, unique-session presence, queue counts, pending-save indicators, and room-specific Reset/Start in the operator dashboard. Ordinary players must be rejected by operator procedures.

**Assignment wording:** this implementation deliberately uses HTTP mutations plus SSE subscriptions. Confirm with the instructor that this meets the assignment's “socket programming” requirement. SSE is an HTTP streaming mechanism; this project does not demonstrate raw TCP/UDP socket programming.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for project conventions. The subscription transport follows [tRPC's subscription documentation](https://trpc.io/docs/server/subscriptions).

## Achievements

Open `/game/achievements` from navigation or My history to collect 15 permanent
badges. Eight badges work in bot and human games, four require human opponents,
and three require bot games. Cards show each condition, progress, and unlock date.
There are no achievement points or gameplay rewards.

Only games started with the achievement update count; existing history is not
backfilled. Players must be signed in at match start. Human games require two
accounts; signed-in bot games also count. Guest/mixed games, forfeits, operator
cancellations, and abandoned games award no badges or progress. A combo lasts
until an empty cell or server timeout ends the turn. All progress, including
individual mine finds and combos, is credited only after normal completion and
successful database persistence. Reopen the collection or focus its tab to refresh.

Badge sharing is off by default. **Allow public badge collection** shares earned
badges and dates at `/players/<publicId>`, independently of history consent. It
never shares locked progress, source matches, or opponents. Results and replays
still require both participants' public-history consent. Revoking badge sharing
applies to subsequent requests; previously viewed data cannot be retracted.

Bot achievement storage contains only the signed-in player's completion summary;
bot results, replays, and analysis remain unsaved. Completion writes are atomic
with human results and idempotent per account/match. Failed writes retry every five
seconds after room disposal, and operator pending/failed totals include achievement
writes. Pending completions remain in memory and can be lost on process failure;
saved badges survive restarts and opponent deletion.

Deploy migration `0003_soft_psynapse.sql` with `pnpm db:migrate` (or the existing VPS
migration helper) before deploying the updated app. No new `.env` settings are
needed. After active games and pending saves finish, the owner must deliberately
restart the application to load game authority runtime version **5**. Development
reloads retain older authorities and require that restart; do not restart an active
server automatically. This release starts achievement tracking from fresh matches.

Verification: `pnpm check`, plus rolled-back PostgreSQL checks with no live data
changes:

```sh
GAME_TEST_DATABASE=1 pnpm exec tsx --env-file=.env --test tests/achievements.test.ts tests/history.test.ts tests/friends.test.ts
```

## Elo leaderboard

`/game/leaderboard` publicly lists account names, Elo, rank, games, wins, and losses
once an account has one rated game. All new two-account results count, including
friend games, rematches, and forfeits. Bot practice, guest/mixed games, and
operator-aborted games are unrated. Public ratings do not grant history, replay,
or achievement access; those privacy settings remain independent.

Everyone starts at 1000. K=32 and the 400-point expected-score formula determine a
single rounded transfer from loser to winner (16 points at equal ratings). Score
margin has no effect. There are no seasons, rating floors, placement multipliers,
or decay. Equal ratings share competition ranks (1, 1, 3); public profile IDs
provide stable ordering within ties. Repeated opponents count normally and
matchmaking is unchanged.

Ratings, result/replay records, and achievements commit atomically. Duplicate
match IDs cannot award points twice. Concurrent completions use locked profile
ratings in transaction order; delayed retries use the latest committed ratings.
Pending/failed saves have not awarded rating points. Unsaved retries are lost on
restart, just like existing unsaved results. Deleting an account removes its
listing without reversing opponents' ratings.

Apply migration `0004_white_tomas.sql` after the preceding migrations. Existing
results retain null rating snapshots and are never backfilled. Before activating
this release, drain games and pending saves, apply migrations with `pnpm db:migrate`
(or `pnpm db:migrate:vps` for the VPS), then have the owner restart the application.
No new environment variables are needed and the authority runtime remains version
5. Do not restart the user's development server automatically.

Run `pnpm check`, then verify persistence using rollback-only temporary tables:

```sh
GAME_TEST_DATABASE=1 pnpm exec tsx --env-file=.env --test tests/history.test.ts tests/achievements.test.ts tests/friends.test.ts
```
