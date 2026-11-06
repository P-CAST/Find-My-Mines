---
marp: true
theme: gaia
size: 16:9
paginate: true
title: Find My Mines
description: Project presentation based on the assignment brief and current implementation.
author: Find My Mines
footer: Find My Mines · Project presentation
---

<!-- _class: lead -->
<!-- _paginate: false -->
<!-- _footer: "" -->

# Find My Mines

### Find the bombs. Read the clues. Beat the clock.

**2 players · 36 cells · 11 bombs · 10 seconds**

A real-time multiplayer game with AI practice and replay coaching

<!--
Opening: Unlike classic Minesweeper, finding a bomb is the objective.
This deck describes implemented behavior from the repository, not a claim
that deployment, live AI calls, or the two-computer demonstration have passed.
Source: assignment PDF, pp. 1–3; README.md; src/server/game/rules.ts.
-->

---

## The assignment

Two players. Two computers. One networked game.

| Assessment area | Points | Presentation evidence |
| :--- | :---: | :--- |
| Preparation & creativity | 5 | Live demonstration |
| Fundamentals | 10 | Game, network, controls |
| Extra features | ≤ 10 | AI and supporting features |

**AI is required.** Extras count after the fundamentals are complete.

<!--
Source: assignment PDF, p. 3. AI features are listed as 2 points and non-AI
features as 1 point, with an extras cap of 10. Do not promise a final score;
acceptance and feature grouping belong to the instructor.
-->

---

## The game in one minute

1. Two players join a room; the server chooses who starts.
2. A covered **6 × 6 board** contains **11 randomly placed bombs**.
3. Reveal a bomb: **+1 point**, and keep the same turn deadline.
4. Reveal an empty cell: see its adjacent-bomb count; play passes.
5. Time runs out after **10 seconds**: play passes automatically.

Find all 11 bombs → higher score wins → both players can rematch.

<!--
Sources: src/server/game/rules.ts; src/server/game/service.ts; README.md,
Rules and runtime. Empty-cell clues include diagonal neighbors; no flood fill.
Revealed cells are disabled. With 11 total points, normal completion cannot tie.
Board generation rejects fully mined 2×2 blocks, connected bomb groups larger
than five, and halves with fewer than three or more than eight bombs. It is
randomized with constraints, not uniform over all possible 11-bomb layouts.
-->

---

## From welcome to rematch

**Choose a nickname or sign in**
↓
**Create a room · Join a room · Find opponent**
↓
**Welcome message · Player names · Scores · Live countdown**
↓
**Win / Lost · Final scores · Two-player rematch vote**

The previous winner starts the rematch on a fresh board.

<!--
Sources: src/app/page.tsx; src/app/game/page.tsx;
src/app/game/[roomId]/page.tsx; GameService.maybeBegin.
Accounts use their account name. Guests choose a nickname before entering.
Initial games start when both seated players connect. Normal completed matches
offer two-party rematches; forfeits instead offer Return to lobby.
-->

---

<!-- _class: lead invert -->

## One server owns the truth

Browsers request moves.
The server validates them, advances the game,
and publishes the same public state to every viewer.

**The hidden board never leaves the server.**

<!--
Source: src/server/game/service.ts. Covered cells serialize as covered only.
Clients cannot choose their own score, turn owner, or hidden bomb layout.
-->

---

## Architecture

```text
 Browser A                  Browser B / spectators
     │  HTTP commands           │  HTTP commands
     ▼                          ▼
          Next.js Node application
          tRPC → GameService
          private boards · turns · timers
     │                          │
     └──── SSE public state ────┘
                    │
          Async completion writer
                    ▼
               PostgreSQL
       account results · replays · ratings
```

<!--
Sources: src/server/api/routers/game.ts; src/server/game/service.ts;
src/server/game/history.ts; src/server/db/schema.ts.
There is one synchronous in-memory authority with isolated rooms. Persistence
runs outside game transitions. Commands and game subscriptions share the Node
route /api/trpc/[trpc]. Messaging has a separate /api/messages/[trpc] route.
The arrows show application data flow, not a raw socket API.
-->

---

## Networking: the implementation choice

| Direction | Transport | Purpose |
| :--- | :--- | :--- |
| Client → server | HTTP / tRPC | Join, reveal, rematch, reset |
| Server → client | SSE / tRPC | Lobby, room, presence |

Reconnects receive full snapshots; revisions reject stale updates.

**Brief alignment:** Uses HTTP + SSE, without raw sockets or WebSockets. Instructor acceptance is required.

<!--
Sources: src/trpc/react.tsx; src/server/game/stream.ts; README.md,
Streaming, timing, and disconnects and Assignment wording.
The brief explicitly requests socket programming and provides several socket
technology examples. Do not describe SSE as WebSockets or claim this requirement
is settled. This is the main requirement-interpretation gap in the current code.
-->

---

## Fair turns, even with delayed clients

- **Server deadlines** advance play without browser requests.
- **Match and turn IDs** reject actions from an earlier game or turn.
- **Synchronous transitions** validate and apply a move together.
- **Signed, HTTP-only cookies** establish identity and seat ownership.
- **Presence leases + reconnect grace** handle interrupted connections.

Finding a bomb keeps the original deadline; it does not add time.

<!--
Sources: src/server/game/service.ts; src/server/game/session.ts;
src/server/game/rules.ts; src/app/_components/game/use-game-connection.ts.
Room heartbeats renew a 15-second lease. After the last room connection is lost,
the player has a further 15-second reservation grace. Timers continue during
grace. A connected opponent wins by forfeit after grace; both disconnected
players cause an abort. Physical disconnection is not detected immediately.
-->

---

## Operator controls

**The server dashboard makes the match observable.**

- See connected game-session count and client nicknames.
- Inspect rooms, queue size, scores and pending saves.
- Reset one room: clear its active game and scores.
- Start again when two players are connected.

Access requires a verified **administrator account**; commands and subscriptions enforce authorization on the server.

<!--
Sources: src/app/operator/page.tsx; src/app/operator/layout.tsx;
src/server/api/routers/game.ts; src/server/better-auth/operator.ts.
The count is unique browser game sessions, not necessarily unique people.
Multiple tabs share a session; operator-only streams do not count as players.
Reset retains connected seats and enters a manual-start lobby. It cancels the
current recording without deleting previously saved history. Do not show or
copy .env.operator.local into slides, screenshots, or presenter notes.
-->

---

<!-- _class: lead invert -->

## Two ways AI supports play

### Practice against a bot.
### Learn from a completed match.

Both use visible game information, without hidden bomb positions.

<!--
Sources: src/server/game/bot.ts; src/server/game/analysis.ts;
src/server/game/openai.ts; README.md.
These features are implemented and require configured provider access.
Availability and live latency must be checked before the demonstration.
-->

---

## AI feature 1 · Practice opponent

**Visible board + clues + legal moves → model → validated move**

- Uses the same board, scoring rules and 10-second turns.
- Receives no hidden bombs, player identities or message-board text.
- Invalid or failed early responses use a random legal fallback.
- Deadline expiry cancels pending work and passes the turn.

Practice rooms are unlisted, unrated, and have no saved replay.

<!--
Sources: src/server/game/bot.ts; src/server/game/service.ts; tests/bot.test.ts.
The server validates the structured move. The model performs deductions; the
server does not secretly provide solved moves. Each bomb keeps the original
deadline. There are at most 36 provider calls per match, no request retries,
and a shared quota of three bot-game starts per rolling hour, including
rematches. Check quota before presenting. API keys stay server-side.
-->

---

## AI feature 2 · Replay coaching

**Saved public replay → anonymized evidence → saved analysis**

- A match participant requests analysis after an account game.
- The report combines calculated statistics with AI coaching.
- Event links jump to the relevant moment in the replay.
- Both players' consent is required for public viewing.

Coaching is an interpretation of visible play, not proof of optimal moves.

<!--
Sources: src/server/game/analysis.ts; src/server/game/history.ts;
src/app/game/replay/[matchId]/page.tsx; tests/analysis.test.ts.
Generation requires a signed-in participant. Authorized viewers can read a
saved report. One report is saved per match and analysis version. Names,
account/session IDs, chat, and hidden layouts are excluded from model evidence.
Both AI features use store:false; this does not eliminate all provider retention.
-->

---

## Beyond the required match

| Extra feature | Value to players |
| :--- | :--- |
| Public and invite-only rooms | Choose how to meet an opponent |
| Matchmaking | Find another waiting player |
| Spectating | Watch a live game without taking a seat |
| Friends and invitations | Challenge an online friend |
| Global message board | Talk across the lobby and rooms |

<!--
Sources: src/app/game/page.tsx; src/server/game/service.ts;
src/server/friends/service.ts; src/server/api/routers/friends.ts;
src/server/messages/service.ts.
Invite-only means unlisted and accessible by link, not password-protected.
Friend invitations reserve seats for the two accounts. Matchmaking pairs
accounts with accounts and guests with guests first; after 30 seconds an account
may match a waiting guest. The message board is global, including unlisted rooms.
These are candidates for extra-feature credit, not an awarded score.
-->

---

## Progress that lasts beyond one game

| Feature | Current behavior |
| :--- | :--- |
| Match history | Saved results for two-account matches |
| Replay playback | Seek, step, play/pause, and 1× / 2× / 4× speed |
| Achievements | 15 badges with separate sharing consent |
| Elo leaderboard | Start at 1000; rated account matches |

Public history and replays require **both participants** to opt in.
Guest and mixed matches do not create saved game records.

<!--
Sources: src/server/game/history.ts; src/lib/achievements.ts; src/lib/elo.ts;
src/server/game/ratings.ts; src/app/game/replay/[matchId]/page.tsx.
Elo uses K=32 and a 400-point expected-score formula; equal ratings transfer
16 points. Bot practice is unrated and creates no result/replay, though eligible
signed-in bot completions can contribute achievement summaries. Do not imply
that all account play, including bot practice, has saved history.
-->

---

## Stack and deployment boundaries

**Next.js App Router · React · TypeScript**
**tRPC + SuperJSON · Better Auth · Drizzle + PostgreSQL**
**Tailwind CSS 4 · DaisyUI 5**

- One persistent Node process serves all rooms.
- Live rooms, queues and unsaved results live in memory.
- Saved account data survives in PostgreSQL.
- Restarting clears live state; multiple replicas are unsupported.

<!--
Sources: package.json; CONTRIBUTING.md; README.md, Rules and runtime.
The app uses the built-in corporate light theme. This slide deck independently
uses Marp's built-in Gaia theme. The deck adds no application dependencies.
Do not imply durable in-progress matches or horizontal scaling.
-->

---

## Demonstration · Two computers

| Computer A | Computer B |
| :--- | :--- |
| Runs the Node server | Runs a browser client |
| Opens a player browser | Opens the same configured origin |

1. Enter nicknames and show both clients in the dashboard.
2. Reveal cells; compare scores, clues and turn changes.
3. Let a turn expire, finish the game, then agree to rematch.
4. Reset from the dashboard and show both scores cleared.

<!--
Sources: assignment PDF, pp. 1 and 3; src/lib/game-config.ts; README.md.
This is a planned demonstration, not an assertion it was executed. Use separate
browser sessions for operator and player identities where needed. Production
address/port are embedded at build time using public configuration; players
have no in-app host/port form. Configure the host's reachable address before
building and use the same origin on both computers. Do not use localhost on
Computer B to reach Computer A. The brief literally says the IP and port must
be set in source; confirm build-time configuration is acceptable as well.
Keep the user's existing server under their control; do not restart it for slides.
-->

---

## Demonstration · Extra features

1. **Bot practice:** show a legal AI move within a normal turn.
2. **Account match:** finish a game and open its saved replay.
3. **AI analysis:** open coaching and jump to a cited event.
4. **Social play:** send a friend invitation and enter the room.
5. **Progress:** show the leaderboard and earned badges.

Prepare two accounts, provider access, and available bot quota.
Keep a saved replay ready for the coaching demonstration.

<!--
Do not promise a specific badge award during a short demonstration; show an
existing earned badge or describe its server-defined condition. Saved analysis
can be shown without making a fresh paid request. A live AI demonstration is
separate from mocked provider tests. Use a normally completed two-account game
to demonstrate the full result, replay, ratings, and achievement workflow.
-->

---

## Verification and requirement alignment

| Area | Evidence / remaining check |
| :--- | :--- |
| Rules, timing, authorization | Behavioral tests |
| Lint and TypeScript | `pnpm check` |
| Live HTTP + SSE | Empty-lobby test |
| Two-computer operation | Live demonstration |
| Socket / address wording | Instructor acceptance |

Live deployment and grading acceptance remain separate checks.

<!--
Sources: package.json; tests/*.test.ts; scripts/verify-game.ts; README.md.
pnpm check runs lint, type checking, and tests. PostgreSQL checks are opt-in,
and real-provider behavior is not established by mocked AI tests.
Run pnpm test:integration only against the existing server with no active rooms
or queued players. It exercises HTTP/SSE, timers, presence, reset, and isolation.
The exact check result for this deck is recorded in slides/README.md.
-->

---

<!-- _class: lead -->
<!-- _footer: "" -->

# Ready to find the last bomb?

**Timed competition. Shared live state. AI-assisted learning.**

### Live demo & questions

<!--
Reference map for questions:
- Assignment: FindMyMines-1525379-17884898817103.pdf, pp. 1–3.
- Rules: src/server/game/rules.ts and src/server/game/service.ts.
- Transport: src/trpc/react.tsx and src/server/game/stream.ts.
- Operator: src/app/operator/page.tsx and src/server/better-auth/operator.ts.
- AI: src/server/game/bot.ts and src/server/game/analysis.ts.
- Persistence: src/server/game/history.ts and src/server/db/schema.ts.
- Setup and limitations: README.md and CONTRIBUTING.md.
-->
