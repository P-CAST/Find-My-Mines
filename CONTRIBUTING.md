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
