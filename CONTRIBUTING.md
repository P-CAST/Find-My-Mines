# Contributor conventions

Keep the existing Next.js App Router, tRPC, Better Auth, and Drizzle/PostgreSQL stack. Preserve stable installed dependency versions. Use the existing pnpm lockfile and startup commands. Do not add another backend, WebSockets, game worker, cron, ORM, or infrastructure service for this single-process, multi-room game.

## Interface

Use native JSX and DaisyUI 5 classes directly with Tailwind 4 for layout. Keep the built-in `corporate` light theme in `src/styles/globals.css` and the root layout. Use semantic theme colors, accessible labels, keyboard-operable controls, and visible focus styles. Reveal state and turns with symbols/text as well as color. Revealed disabled board cells must remain readable.

Reuse the six small components in `src/app/_components/game/ui.tsx`: `PageShell`, `Panel`, `PlayerScore`, `GameCell`, `TurnTimer`, and `ConnectionStatus`. Use `btn-primary` for Join, Rematch, and Start; default buttons for secondary actions and Cancel; `btn-error` for Reset. Prefer DaisyUI cards, fieldsets, stats, badges, alerts, progress, tables, loading indicators, and native-dialog modals. Avoid wrapper libraries, custom palettes, decorative animation, extra design-system abstractions, and custom CSS beyond framework setup.

## Game architecture

Expose game procedures in `src/server/api/routers/game.ts` and register in the existing root router. Keep all authoritative transitions synchronous in `src/server/game/service.ts`; never await between validation and changes. Capture account-only terminal results synchronously; save results and replays atomically outside transitions with idempotent match IDs. Never persist game records involving guests. Keep room state isolated by room ID and account/guest ownership derived from verified cookies. Hidden boards stay server-side; replay frames contain only public states. Only import public service types into browser modules with `import type`. Keep server-issued session credentials in HTTP-only cookies. A public UUID or nickname is not authentication. Enforce operator authorization in procedures.

Use HTTP mutations for commands and SSE for updates through the same Node route. Keep SuperJSON, existing HTTP batching, and unrelated auth/post procedures. Bootstrap/auth calls require nonstreaming HTTP responses to set cookies. Register update listeners before snapshots; send full snapshots on reconnect; clean listeners on cancellation/lease expiry; guard UI state with revisions. Do not send countdown ticks. Maintain session-level presence with reference-counted streams and a lease; never treat operator streams as game clients.

Retain one global game service under development reloads. Do not assume globals cross process boundaries. Changes to stored service fields require a user-managed restart; method reloads preserve the instance. Review the runtime/disconnect limitations in README before changing this design. If tests need fresh state, instantiate `GameService` with an injected clock, scheduler, and board generator. Never expose deterministic test boards in the live API.

## Messaging

Keep messaging procedures on the dedicated `/api/messages/[trpc]` Node route and game/post procedures on `/api/trpc/[trpc]`. Share cookie verification and transport settings, but keep the messaging authority, revisions, listeners, and connection state separate. Never attach messaging streams to game presence or renew game leases from messaging. Keep only the latest 100 messages in memory; do not add messages to match recordings or PostgreSQL. Preserve plain-text rendering and server-enforced posting limits. The shared message-board component has two actual page consumers; keep its single-use logic in that file.

## Verification

Run `pnpm check`. Add focused behavioral tests for meaningful rule changes. `pnpm test:integration` uses the existing server and requires no rooms or queued players; it verifies actual HTTP/SSE fanout, autonomous timers, presence, reconnects, room isolation, forfeits, and operator controls. The opt-in PostgreSQL test (`GAME_TEST_DATABASE=1 pnpm exec tsx --env-file=.env --test tests/history.test.ts`) uses rolled-back temporary tables to check result/replay persistence and privacy. Never stop/restart the user's development server or run an unisolated duplicate. Do not run a production build into the running dev server's `.next` output; use a separate temporary checkout/output for build verification if needed.

## Friends

Friend relationships live in PostgreSQL; search and relationship procedures use the
protected `friends` router on `/api/trpc`. Only account names and public profile
IDs are discoverable. Friendships never grant history/replay access. Keep pair
changes serialized with invitation authorization through the social service.

Social SSE leases are independent of game presence: five-second heartbeats renew
15-second leases for the verified auth session, with reference counting across
tabs and devices. Revalidate long-lived auth sessions and close revoked streams.
Never connect a social stream to `GameService.connect` or renew room heartbeats
from the layout. Signed-in social connections run on every page.

Invitation procedures remain in the game router, with synchronous transitions in
the retained game authority. Perform database friendship checks before entering
those transitions. Accepted games reserve both seats for those accounts, including
when a reservation expires; an unlisted link only permits other accounts to watch.
Run `pnpm check`; the opt-in temporary-table PostgreSQL friend checks are
`GAME_TEST_DATABASE=1 pnpm exec tsx --env-file=.env --test tests/friends.test.ts`.

## Achievements

Keep the 15 stable badge IDs and conditions in `src/lib/achievements.ts`. Capture
per-seat counters synchronously at match start/reveal/timeout and enqueue facts
only for normally completed eligible games. Never infer awards from client claims,
AI output, hidden board serialization, or replay reads. Bot summaries must not
create result/replay records. Guest and mixed matches remain entirely unpersisted.

Use the completion writer to save human results, per-account summaries, and earned
badges atomically. Acquire profile row locks in sorted account-ID order before
inserting results or summaries. Unique account/match and account/badge keys make
retries idempotent. Do not backfill achievements from old results. Keep permanent
badges independent of result rows and opponent accounts. Public badge reads must
check the separate opt-in consent in the same query and expose only badge IDs and
unlock dates; badge sharing never grants history or replay access.

Stored achievement tracking and completion payloads require authority runtime
version 5 and a deliberate owner-managed restart after draining games and saves.
Apply migration 0003 before the updated app. Run `pnpm check` and the PostgreSQL
command documented in README; database tests create only rolled-back temporary
tables and close their own connection pools.

## Elo

Apply ratings only for newly inserted two-account result rows in the completion
transaction, after acquiring profile locks in sorted account-ID order. Update
both ratings and counters with the result/replay and achievement writes; duplicate
match IDs and legacy results must never receive a second award. Use `src/lib/elo.ts`
for the symmetric integer transfer. Keep rating I/O outside synchronous game
transitions. Public leaderboard reads expose only public identity and aggregate
statistics; match deltas require an authenticated participant. Keep friend-search
profile insertion aligned with the Drizzle profile schema. Migration 0004 is
additive; drain games and saves before owner-managed activation, without backfill.
