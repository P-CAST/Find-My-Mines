# Contributor conventions

Keep the existing Next.js App Router, tRPC, Better Auth, and Drizzle/PostgreSQL stack. Preserve stable installed dependency versions. Use the existing pnpm lockfile and startup commands. Do not add another backend, WebSockets, game worker, cron, ORM, or infrastructure service for this single-match game.

## Interface

Use native JSX and DaisyUI 5 classes directly with Tailwind 4 for layout. Keep the built-in `corporate` light theme in `src/styles/globals.css` and the root layout. Use semantic theme colors, accessible labels, keyboard-operable controls, and visible focus styles. Reveal state and turns with symbols/text as well as color. Revealed disabled board cells must remain readable.

Reuse the six small components in `src/app/_components/game/ui.tsx`: `PageShell`, `Panel`, `PlayerScore`, `GameCell`, `TurnTimer`, and `ConnectionStatus`. Use `btn-primary` for Join, Rematch, and Start; default buttons for secondary actions and Cancel; `btn-error` for Reset. Prefer DaisyUI cards, fieldsets, stats, badges, alerts, progress, tables, loading indicators, and native-dialog modals. Avoid wrapper libraries, custom palettes, decorative animation, extra design-system abstractions, and custom CSS beyond framework setup.

## Game architecture

Expose game procedures in `src/server/api/routers/game.ts` and register in the existing root router. Keep all authoritative transitions synchronous in `src/server/game/service.ts`; never await between validation and changes. Hidden boards stay server-side. Only import public service types into browser modules with `import type`. Keep server-issued session credentials in HTTP-only cookies. A public UUID or nickname is not authentication. Enforce operator authorization in procedures.

Use HTTP mutations for commands and SSE for updates through the same Node route. Keep SuperJSON, existing HTTP batching, and unrelated auth/post procedures. Bootstrap/auth calls require nonstreaming HTTP responses to set cookies. Register update listeners before snapshots; send full snapshots on reconnect; clean listeners on cancellation/lease expiry; guard UI state with revisions. Do not send countdown ticks. Maintain session-level presence with reference-counted streams and a lease; never treat operator streams as game clients.

Retain one global game service under development reloads. Do not assume globals cross process boundaries. Changes to stored service fields require a user-managed restart; method reloads preserve the instance. Review the runtime/disconnect limitations in README before changing this design. If tests need fresh state, instantiate `GameService` with an injected clock, scheduler, and board generator. Never expose deterministic test boards in the live API.

## Verification

Run `pnpm check`. Add focused behavioral tests for meaningful rule changes. `pnpm test:integration` uses the existing server and requires an empty lobby; it verifies actual HTTP/SSE fanout, autonomous timers, presence, reconnects, and operator controls. Never stop/restart the user's development server or run an unisolated duplicate. Do not run a production build into the running dev server's `.next` output; use a separate temporary checkout/output for build verification if needed.
