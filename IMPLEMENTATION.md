# Find My Mines: Requirements and Extra Features

This document explains how the current codebase implements the Find My Mines assignment and proposes eight extra-feature groups worth **10 points: two AI features × 2 points, plus six non-AI features × 1 point**. It covers the player experience, server behavior, data storage, and evidence that can be shown during assessment.

The source brief is `FindMyMines-1525379-17884898817103.pdf`, pages 1–3. The accompanying [presentation](slides/find-my-mines.html) and its [Markdown source](slides/find-my-mines.md) provide the shorter demonstration narrative. Repository links below point to the implementation, not just the presentation claims.

The brief allocates 5 points for preparation and creativity, 10 for fundamentals, and at most 10 for extras. Extra credit is conditional on completing the fundamentals. The proposed grouping is an assessment submission plan; the instructor determines acceptance and the final score.

## 1. Overall design

Find My Mines is a competitive two-player game. Unlike traditional Minesweeper, players **want to find bombs**: each bomb earns one point. An empty cell supplies a clue but hands the turn to the opponent. Both players see the same 6 × 6 board and compete to collect its 11 bombs.

The application uses Next.js App Router and React for its pages, tRPC for typed client–server procedures, SuperJSON for transport serialization, Better Auth for accounts, and Drizzle with PostgreSQL for persistent data. Tailwind CSS 4 provides layout utilities and DaisyUI 5 supplies controls using the built-in `corporate` light theme.

The central design decision is that **the server owns every game rule and state transition**. A browser requests a reveal; it cannot choose its score, decide that a cell contains a bomb, or declare itself the winner.

```text
Browser A                         Browser B / spectator
    | HTTP commands                    | HTTP commands
    +----------------+-----------------+
                     v
       Next.js Node route /api/trpc/[trpc]
           Identity checks + tRPC validation
                     |
                     v
            One in-memory GameService
       Rooms / private boards / turns / deadlines
                     |
        Public snapshots over tRPC SSE
                     |
         Asynchronous completion writer
                     v
                  PostgreSQL
       Results / replays / ratings / achievements
```

This shows application data flow. The networking implementation is HTTP plus Server-Sent Events (SSE), rather than an application-level raw-socket or WebSocket implementation.

| Layer | Main implementation | Responsibility |
| --- | --- | --- |
| Player interface | [Lobby](src/app/game/page.tsx), [room page](src/app/game/[roomId]/page.tsx) | Room selection, board, scores, timer, results and rematch |
| Shared game UI | [ui.tsx](src/app/_components/game/ui.tsx) | `PageShell`, `Panel`, `PlayerScore`, `GameCell`, `TurnTimer`, `ConnectionStatus` |
| Client connection | [use-game-connection.ts](src/app/_components/game/use-game-connection.ts), [tRPC client](src/trpc/react.tsx) | Session bootstrap, commands, subscriptions, heartbeat and reconnect handling |
| Game API | [game router](src/server/api/routers/game.ts) | Input validation, identity, operator permissions and procedure routing |
| Game authority | [service.ts](src/server/game/service.ts), [rules.ts](src/server/game/rules.ts) | Synchronous transitions, private board, timing, scoring and room isolation |
| Persistent completion | [history.ts](src/server/game/history.ts), [schema.ts](src/server/db/schema.ts) | Transactional results, replay data, rating changes and achievement writes |

## 2. Fundamental requirements

### 2.1 Client–server communication and two-computer setup

**Brief:** A server waits for connections, clients connect to it, and the game works between computers. One computer runs both server and client; another runs only a client.

**Implementation:** The Node application serves the browser interface and tRPC endpoints. Each browser establishes its game session before subscribing to lobby or room state. Commands such as `game.join`, `game.reveal`, `game.rematch`, and `game.reset` travel over HTTP. Subscriptions such as `game.onLobby` and `game.onState` receive server-published snapshots over SSE.

The two computers do not communicate directly with each other. Both use the same server origin. Computer A can run the Node application and open a player browser; Computer B opens that reachable origin in its browser. No separate native game-client installation is required.

**Requirement qualification:** The brief explicitly requests socket programming. The current implementation uses HTTP and SSE through framework APIs; it does not implement raw TCP sockets, Socket.IO, or WebSockets. It demonstrates real-time client–server behavior, but this alone does not establish compliance with the assignment's socket-programming requirement. Instructor acceptance of this transport choice remains necessary. A two-computer demonstration also remains separate from source-code verification.

### 2.2 Server address and port without player input

**Brief:** Clients know the address and port without asking users to enter them in the game; the address and port are set in source code.

[game-config.ts](src/lib/game-config.ts) centralizes `SERVER_ADDRESS`, `SERVER_PORT`, `SERVER_PROTOCOL`, and `SERVER_ORIGIN`. The tRPC client uses this origin for requests and subscriptions. There is no in-game IP-address or port-entry form.

In development, browser requests use the current page origin, allowing a browser that opened the host's network address to keep using that address. In production, public domain/IP and port configuration is embedded at build time through `NEXT_PUBLIC_PRODUCTION_DOMAIN`, `NEXT_PUBLIC_PRODUCTION_IP`, and `NEXT_PUBLIC_PRODUCTION_PORT`, with source defaults. The configured protocol is HTTP.

**Requirement qualification:** Centralized source defaults and build-time configuration fulfill the automatic-connection behavior. The brief's literal requirement to set the IP and port in source should still be confirmed with the instructor. Both computers must open the reachable configured server origin; `localhost` on Computer B refers to Computer B itself.

### 2.3 Connected clients and awareness of other players

**Brief:** The server displays the number of concurrent clients and their list, and clients receive information about other connected clients.

`GameService.clients()` produces the operator snapshot: session count, client entries, room assignments, queue size, room summaries, and pending or failed saves. The [operator dashboard](src/app/operator/page.tsx) subscribes to `game.onClients`. Room inspection uses `game.onRoom`.

The count represents **game browser sessions**, rather than a count of people or open tabs. Multiple streams from the same session are reference-counted. An operator-only subscription does not create player presence. A seated or queued session has its player nickname; a session that has not joined or queued can appear as `Not joined`.

Ordinary clients receive public room summaries through `game.onLobby` and participant names, scores, and connection state through `game.onState`. They therefore learn about players in the games they browse or enter. The complete server-wide client directory is operator-only. If the brief is interpreted as requiring every client to receive every connected session, this narrower visibility needs instructor confirmation.

### 2.4 Nicknames and welcome message

**Brief:** Each player enters a nickname and sees a welcome message containing it.

The [homepage](src/app/page.tsx) lets guests choose a nickname before entering a game. [session.ts](src/server/game/session.ts) validates trimmed guest names as 1–24 visible characters and rejects control characters. The name is bound to the signed browser guest session, which lasts up to 24 hours. Direct game links redirect unnamed guests to the homepage, preserving their destination.

Signed-in players use their account name instead of entering a new nickname for every game. The room page displays `Welcome, <nickname>.` for the seated player. Names are display labels; they do not authorize moves. Account ownership comes from verified Better Auth sessions, and guest ownership comes from signed HTTP-only cookies.

### 2.5 Random 6 × 6 board with 11 bombs

**Brief:** The server randomly places exactly 11 bombs on a 6 × 6 grid, initially covered.

[rules.ts](src/server/game/rules.ts) defines `BOARD_SIZE = 6`, `CELL_COUNT = 36`, and `BOMB_COUNT = 11`. `generateBoard()` uses a partial Fisher–Yates shuffle with `node:crypto` randomness to choose 11 distinct cell indices. `GameService.begin()` generates the board before changing match state, then initializes every public cell as `{ kind: "covered" }`.

The generator additionally rejects fully mined 2 × 2 blocks, connected bomb groups larger than five (including diagonal connectivity), and board halves containing fewer than three or more than eight bombs. It tries at most 1,000 candidates and reports failure if none qualifies. This is randomized generation with layout constraints; it should not be described as unrestricted sampling of every possible 11-bomb board.

The private bomb set stays in the server room. Snapshots contain only covered cells, revealed bombs, or revealed empty cells with their clue values. Watching a game or inspecting its network response does not expose the hidden board.

### 2.6 Player names and scores

The room snapshot includes both players' nicknames and scores. The room page renders them with `PlayerScore`, including the active-turn indicator. Scores start at zero whenever `begin()` creates a match and update through the server's published snapshots. Spectators see the same public score state.

### 2.7 Random first player

For an initial match, `begin()` selects a player using the authority's random first-player function, which defaults to `randomInt(2)`. The browser does not choose who starts. A normal room begins only when both seated players are connected to that room.

Tests can inject a deterministic first-player function for reproducibility; the public API does not expose that test control.

### 2.8 Ten-second turns, bombs and empty cells

**Brief:** A player has ten seconds per turn. Finding a bomb keeps the turn until time expires; revealing an empty cell passes play.

`TURN_MS = 10_000`. `GameService.newTurn()` assigns the active player, creates a new turn ID, sets the deadline to server time plus ten seconds, and schedules server-side timing. `applyReveal()` handles the two outcomes:

| Reveal outcome | Board update | Score update | Turn behavior |
| --- | --- | --- | --- |
| Bomb | Cell becomes `bomb` | Active player gains 1 | Keeps the existing deadline unless the match ends |
| Empty | Cell becomes `empty` with adjacent-bomb count | No point | Opponent receives a fresh ten-second turn |
| Deadline expires | No cell is revealed | No point | Server passes play automatically |

For example, if a player finds a bomb seven seconds into a turn, they have approximately three seconds left. Finding a bomb does not reset the clock.

`TurnTimer` renders the countdown from the server deadline and a client/server clock offset. Heartbeat responses improve that offset estimate. The browser updates the visible timer locally; the server does not broadcast a new game snapshot every second. The authoritative timeout works even if no browser sends another move.

### 2.9 Reveal markings, adjacent clues and disabled cells

`adjacentBombs()` checks the eight surrounding positions, including diagonals, while respecting board edges. An empty cell reveals its count, including zero; there is no automatic flood fill.

`GameCell` presents covered, bomb and numbered-empty states using text/symbols as well as theme colors. Revealed cells are disabled and remain legible. The room also disables interaction when the viewer cannot act, such as during an opponent's turn or when spectating.

The server repeats these checks. `reveal()` verifies seat ownership, room connection, active match, current match ID, current turn ID and active player. `applyReveal()` rejects invalid indices and already revealed cells. A modified browser or a repeated click cannot award the same bomb twice.

### 2.10 Match completion and result screen

After a bomb reveal, the authority checks whether the sum of scores equals 11. If so, `finish()` selects the higher-scoring player, marks the room finished, clears its active deadline and turn owner, and publishes the final state.

The room page shows the seated player's `Win` or `Lost` status, both final scores, and the rematch controls for a normally completed match. Since a normal game distributes 11 points between two players, it cannot end in a tie. The game continues until all bombs are found, even if one player reaches six points earlier.

Disconnect forfeits are an additional terminal case. They can finish a match before all bombs are found and are labeled accordingly. The normal two-player rematch flow is offered for completed games; forfeits lead players back toward the lobby.

### 2.11 Two-player rematch with the previous winner starting

`game.rematch` takes the room and finished-match IDs. The authority verifies that the caller owns a connected seat and that the result is still eligible. Votes are stored in a set, so duplicate requests do not count as another player's agreement.

`maybeBegin()` starts the rematch only when both players have voted and are connected. It passes the previous winner into `begin()`, giving that player the first turn. The new match receives a fresh randomized board, zero scores, cleared votes, and new match/turn IDs.

### 2.12 Server reset button

The operator dashboard exposes Reset for a room. `game.reset` uses server-side administrator authorization through [requireOperator](src/server/better-auth/operator.ts), rather than relying on a hidden button alone.

`GameService.reset()` cancels current bot work and timing, clears the private board and replay buffer for the interrupted game, restores covered cells, clears winner/rematch state, and resets scores to zero. Connected seats remain; disconnected or released seats are cleaned up. The room enters a manual-start lobby, where the operator can start again once two players are connected.

Reset does not delete previously saved match history. The interrupted unfinished game does not become a completed result or earn achievements. Operator subscriptions revalidate permissions before delivery and periodically, and release resources if authorization is revoked.

## 3. Reliability supporting the requirements

All authoritative game transitions run synchronously inside one `GameService`. Database and model calls run outside those transitions. Validation and applying a move therefore happen together without an intervening awaited request that could allow another transition to change the board.

Each command targets a room, and reveals also carry match and turn IDs. These IDs reject delayed actions from an earlier turn, rematch or reset. Snapshots carry an increasing revision and server instance ID; the connection hook rejects older revisions while accepting fresh state from a new instance.

[gameStream](src/server/game/stream.ts) installs its listener before taking the initial snapshot, avoiding an update gap. Reconnecting clients receive full snapshots. Stream cancellation, terminal room closure and expired presence leases clean up listeners and connection references.

Game heartbeats run every five seconds and renew a 15-second lease. Losing the last room connection starts a further 15-second seat-reservation grace period. Turns continue during this grace period. A connected opponent can win by forfeit when the reservation expires; if both players are disconnected, the game can be aborted. Physical network failure is consequently not detected instantly. Keeping only a lobby, messaging or social connection open does not keep a room seat connected indefinitely.

## 4. Proposed extra-feature allocation: 10 points

The presentation lists more than six individual non-AI capabilities. For this document, related capabilities are grouped into six complete user-facing features, avoiding separate point claims for every supporting control.

| ID | Feature group | Type | Proposed points |
| --- | --- | --- | ---: |
| AI-1 | AI practice opponent | AI | 2 |
| AI-2 | AI replay analysis and coaching | AI | 2 |
| N-1 | Multiple rooms, matchmaking and live spectating | Non-AI | 1 |
| N-2 | Persistent match history and interactive replays | Non-AI | 1 |
| N-3 | Friends, online presence and game invitations | Non-AI | 1 |
| N-4 | Global real-time message board | Non-AI | 1 |
| N-5 | Achievement collection and progress | Non-AI | 1 |
| N-6 | Elo ratings and leaderboard | Non-AI | 1 |
| | **Total: eight feature groups** | | **10** |

### AI-1. AI practice opponent — 2 points

**Player value:** A player can practice the same competitive rules without waiting for another human. Guests and account users launch it through **Play with bot** in the lobby.

**Implementation flow:**

1. `game.createBot` creates an unlisted practice room with a human seat and a bot seat.
2. When the bot can act, `GameService.syncBot()` builds evidence from the public board, anonymous self/opponent scores and remaining time.
3. [buildBotInput](src/server/game/bot.ts) constructs a labeled A–F / 1–6 grid, row-major indices 0–35, legal covered indices, and explicit visible neighbors for each clue.
4. The provider requests a structured response containing only `cellIndex`. Its instructions explain that bombs are desirable, empty cells pass the turn, and overlapping clues can support deductions.
5. The response is parsed and validated. Before applying it, the authority checks that the job still belongs to the current game state and that the cell remains covered. The move then uses the same `applyReveal()` rules as human play.

The model performs the choice and deduction; the server does not secretly supply hidden bomb locations or a solved move. The input builder explicitly selects public fields. Names, account/session IDs and message-board text are excluded.

**Timing and failure handling:** Requests use only the remaining normal turn time. A bomb preserves the existing deadline, so the next request gets less time. There are no request retries and at most 36 provider calls per match. An invalid response or early provider failure uses a random covered cell and displays a fallback notice. If the deadline expires, pending work is canceled and the turn passes without a timeout fallback reveal. Late responses cannot apply to a different turn.

**Limits and persistence:** A shared in-memory quota allows three bot-game starts per rolling hour across all users; rematches and starts after reset consume quota too. The bot automatically agrees to eligible rematches. Bot games are unrated and save no result, replay or replay analysis. A signed-in human's normally completed bot match can nevertheless produce an achievement summary, as explained under N-5.

**Configuration:** Server-only `OPENAI_API_KEY` and `OPENAI_BOT_MODEL` enable the provider. [openai.ts](src/server/game/openai.ts) sends requests to the Responses endpoint with `store: false`; that flag should not be represented as a guarantee of zero provider retention. Actual model latency and compatibility require a configured live demonstration.

**Evidence:** [bot.ts](src/server/game/bot.ts), `createBot`/`syncBot` in [service.ts](src/server/game/service.ts), and [bot tests](tests/bot.test.ts).

**Demo:** Start a practice game, show a legal bot reveal during its turn, and explain the visible clues available to it. Show the quota indicator and distinguish a model move from any explicitly labeled fallback.

### AI-2. AI replay analysis and coaching — 2 points

**Player value:** Players can revisit a saved match and receive explanations of important moments and practical advice for each participant. This complements the opponent feature: one AI acts during practice, while the other explains completed play.

**Implementation flow:**

1. An authenticated match participant requests `game.generateAnalysis` from the [replay page](src/app/game/replay/[matchId]/page.tsx).
2. The history store verifies participation and loads the saved public replay. Having a public replay link does not grant generation permission.
3. [buildEvidence](src/server/game/analysis.ts) validates the replay and derives statistics: scores, bombs, empty reveals, timeouts, longest scoring runs, turn changes and duration.
4. It creates anonymized events with sequence numbers, elapsed times, the acting seat, known board before a reveal, and the subsequent outcome. Explicit field selection excludes names, private identities, chat and hidden layouts.
5. The model returns a structured summary, at most five key moments, and one coaching entry per player with at most three tips each.
6. The server validates the report schema and verifies that cited sequence numbers exist. It saves the report alongside server-calculated statistics and displays links that seek to the cited replay events.

Statistics are calculated by code; coaching prose is generated by the model. The prompt distinguishes what was known before a move from later revelations and asks the model not to claim optimal play, guaranteed missed bombs, exact probabilities or player intent. The result remains an interpretation of recorded evidence.

**Reuse and limits:** One report is stored per match and analysis version. Concurrent requests for that report share pending work, and later requests reuse the saved result. Generation allows five attempts per account per rolling hour and two distinct requests in flight globally. Evidence is capped at 64 KiB, and the provider request has a 60-second timeout. Failures release pending slots and return an error rather than storing an invalid report.

**Access and configuration:** `OPENAI_ANALYSIS_MODEL` is separate from the bot model. Participants can read their report; public/nonparticipant access follows the match's current two-party history consent. Saved reports are permission-checked on read and can be reused without a new model call. Games without saved replays, including bot and guest games, cannot use this feature.

**Evidence:** [analysis.ts](src/server/game/analysis.ts), [history.ts](src/server/game/history.ts), [analysis tests](tests/analysis.test.ts).

**Demo:** Open a completed two-account replay, display its statistics and coaching, and select a key moment to jump to the corresponding event. A saved report demonstrates the UI; a fresh request separately demonstrates live provider operation.

### N-1. Multiple rooms, matchmaking and live spectating — 1 point

**Player value:** Multiple pairs can play independently, players can find an opponent automatically, and others can watch without occupying a seat.

`GameService` stores rooms in a map keyed by room ID. Each room owns its board, players, match/turn IDs, deadlines, votes and replay buffer. Room-scoped listeners publish its state independently. Resetting or playing in one room does not change another room's match.

Public rooms appear in the lobby. Invite-only rooms use `unlisted` visibility and are accessed through their link; they are not password-protected. A spectator receives the public room state, but reveal/rematch authorization still requires ownership of a seated player. One identity can occupy only one room or queue entry at a time, and an account cannot play against itself across devices.

**Find opponent** uses a server queue. Accounts pair with accounts and guests with guests, FIFO within each group. After an account has waited 30 seconds, it may pair with a waiting guest. A server timer can trigger this crossover without another user action. Matches create unlisted rooms and reserve seats for 15 seconds while players navigate into them. Players can cancel queueing; stale entries and unused handoffs are cleaned up.

**Evidence:** [Lobby](src/app/game/page.tsx), room creation/join/queue methods in [service.ts](src/server/game/service.ts), [room tests](tests/rooms.test.ts).

**Demo:** Create two public rooms and show that a reveal affects only one. Open a third browser as spectator. Then demonstrate automatic pairing or queue cancellation.

### N-2. Persistent match history and interactive replays — 1 point

**Player value:** Account players can keep results and review how a match unfolded after leaving its live room.

When both seats belong to accounts, `begin()` enables recording. `frame()` captures public states for events such as start, reveal, timeout, presence change and forfeit. Frames use sequence numbers and elapsed times; player identifiers in the recording are seat labels. The replay preserves what viewers could see at each moment, rather than exposing a hidden-board solution. Display names remain part of saved match/replay data; the additional anonymization for model input happens in AI-2.

At completion, `finish()` captures an immutable record containing participants, names, scores, winner, timestamps, reason and replay frames. An asynchronous writer saves it outside the synchronous move transition. Failed completion saves are retried after five seconds, and match-ID uniqueness makes retries idempotent. The UI can distinguish recording, pending, saved, failed and unrecorded status.

The [history interface](src/app/_components/game/history-view.tsx) reads paginated results, and the [replay page](src/app/game/replay/[matchId]/page.tsx) supports seeking, event stepping, play/pause and 1×, 2× or 4× playback. Playback operates on stored frames and does not rerun the original live game.

Only two-account human matches create result/replay records. Account forfeits can be recorded; games involving a guest and bot practice cannot. Reset or abandonment does not create an ordinary completed result. Participants can access their matches, while nonparticipant/public access requires both participants' current `historyPublic` consent. Friendship alone grants no replay access.

**Evidence:** [history.ts](src/server/game/history.ts), [database schema](src/server/db/schema.ts), [room tests](tests/rooms.test.ts), [database history tests](tests/history.test.ts).

**Demo:** Finish a two-account game, open history, replay a reveal and a timeout, and change playback speed. Explain that a public link alone cannot override either participant's privacy choice.

### N-3. Friends, online presence and game invitations — 1 point

**Player value:** Account users can find people they know and invite them directly into a match.

The [friends page](src/app/friends/page.tsx) uses the protected [friends router](src/server/api/routers/friends.ts). Relationships are stored in PostgreSQL through [friendStore](src/server/friends/store.ts). Search exposes account names and public profile IDs rather than private authentication credentials. Request, response and removal operations check which account is allowed to perform them.

[SocialService](src/server/friends/service.ts) tracks online status separately from game-room presence. Five-second heartbeats renew 15-second social leases, with reference counting across tabs and devices. Signed-in social connections run across pages, so someone can be available for an invitation while browsing history. This does not extend a disconnected game seat's lease. Long-lived social authentication is revalidated and revoked sessions are closed.

`game.inviteFriend` verifies an accepted friendship and that both accounts are online. Acceptance rechecks the relationship and availability before the synchronous game authority creates a room reserved for those two accounts. Other accounts with the link may watch but cannot claim those reserved seats. Pending invitations can expire, be declined/canceled, or become invalid when an account enters another game or queue.

Pair operations are serialized to prevent conflicting relationship and invitation changes. Server rate limits and pair cooldowns constrain repeated requests. Friend relationships persist; live invitations and online leases remain in memory.

**Evidence:** [friends service](src/server/friends/service.ts), [game router](src/server/api/routers/game.ts), [friends tests](tests/friends.test.ts).

**Demo:** Use two accounts to establish a friendship, show online status, send an invitation and accept into the reserved room. Open its link with another identity to demonstrate spectator-only access.

### N-4. Global real-time message board — 1 point

**Player value:** Players can communicate across the lobby and game rooms while watching or playing.

The shared [GlobalMessageBoard](src/app/_components/game/global-message-board.tsx) appears in both lobby and room pages. [MessageService](src/server/messages/service.ts) manages its own messages, revision and listeners. The [messages router](src/server/api/routers/messages.ts) runs on the dedicated `/api/messages/[trpc]` route with HTTP posting and SSE updates.

Messages use the verified account name or established guest nickname. The server trims text, permits 1–500 characters, rejects disallowed control characters, requires at least two seconds between accepted posts, and allows at most ten per rolling minute per identity. The UI renders plain text rather than executable HTML. Public snapshots identify which posts belong to the viewer without exposing the internal author key.

Only the latest 100 messages are kept in memory. They are not stored in PostgreSQL, included in replays, or supplied to either AI feature. Messaging connections do not count as game presence or keep seats alive. The board is **global**, including when accessed from an unlisted room; it is not private room chat.

**Evidence:** [message service](src/server/messages/service.ts), [message tests](tests/messages.test.ts).

**Demo:** Send a message from the lobby and show it arriving in a room browser. Demonstrate plain-text rendering and the posting cooldown.

### N-5. Achievement collection and progress — 1 point

**Player value:** Players gain persistent goals beyond winning a single match and can optionally share earned badges.

[achievements.ts](src/lib/achievements.ts) defines 15 stable badges and thresholds:

| Badge | Award condition |
| --- | --- |
| First Discovery / Mine Collector / Mine Hunter | Find 1 / 25 / 100 mines across eligible completed games |
| First Expedition / Regular Explorer | Complete 1 / 10 eligible games |
| Triple Find / Chain Reaction | Find 3 / 5 mines in one turn |
| On the Clock | Win without timing out on any turn |
| Friendly Rival / Proven Rival | Win 1 / 10 games against other accounts |
| By a Whisker | Win a human game 6–5 |
| Comeback | Win a human game after trailing by at least three mines |
| Bot Breaker / Practice Champion | Win 1 / 5 bot games |
| Outclassed | Win a bot game with at least nine mines |

The authority tracks maximum consecutive bombs within a turn, timeouts and maximum score deficit alongside ordinary scoring. It captures achievement facts only for normally completed eligible games. The [achievement persistence layer](src/server/game/achievements.ts) aggregates those facts and awards badges through the completion transaction. Client claims, replay reads and AI text cannot grant an award.

Eligible games are two-account human matches and signed-in human bot practice. Guest and mixed guest/account games generate no achievement summaries. Forfeits, resets and aborted games do not award badges. Signed-in bot practice stores the human's achievement facts without creating a result or replay record.

Unique account/match and account/badge keys prevent duplicate progress or awards during retries. Permanent badges are independent of result rows and opponent accounts. The [achievements page](src/app/game/achievements/page.tsx) shows progress and earned badges. Public badge access uses a separate opt-in setting and exposes badge IDs and unlock dates; enabling it does not make match history public. Old results are not automatically backfilled into this system.

**Evidence:** [badge definitions](src/lib/achievements.ts), [achievement writer](src/server/game/achievements.ts), [achievement tests](tests/achievements.test.ts).

**Demo:** Show the collection and a badge's exact condition. Use an existing award or complete an eligible game; finding a mine in an unfinished game is not itself a persisted award.

### N-6. Elo ratings and leaderboard — 1 point

**Player value:** Account players can compare performance over multiple matches, with stronger-opponent wins having more rating impact.

Accounts start at 1000. [eloChange](src/lib/elo.ts) uses a 400-point expected-score formula and K = 32:

```text
expectedWinner = 1 / (1 + 10 ^ ((loserRating - winnerRating) / 400))
transfer = round(32 × (1 - expectedWinner))
winnerAfter = winnerBefore + transfer
loserAfter  = loserBefore  - transfer
```

At equal ratings, 16 points transfer: two players at 1000 become 1016 and 984. The code rounds one transfer and applies its exact opposite to the other player, preserving a symmetric change.

`saveCompletion()` locks participant profile rows in sorted account-ID order, inserts the result, and updates ratings and win/loss counters in the same transaction as replay and achievement writes. Only a newly inserted match result applies rating changes, so a retry cannot rate the same match twice. New two-account results, including forfeits, are rated. Guest/mixed games and bot practice are unrated; legacy results are not backfilled.

The public [leaderboard](src/app/game/leaderboard/page.tsx) includes accounts with at least one rated game. [ratingStore](src/server/game/ratings.ts) returns public names/profile IDs, rating, aggregate games/wins/losses and rank, paginated in groups of 50. Equal ratings share rank. Detailed before/after changes for a particular match require an authenticated participant and do not become public merely because the leaderboard is public.

**Evidence:** [Elo formula](src/lib/elo.ts), [rating store](src/server/game/ratings.ts), [completion transaction](src/server/game/history.ts), [Elo tests](tests/elo.test.ts).

**Demo:** Show both participants' ratings before and after an eligible game, the symmetric transfer, and the updated leaderboard.

## 5. Persistence and access boundaries

| Data or activity | Where it lives | Important boundary |
| --- | --- | --- |
| Live rooms, hidden boards, turns and queues | Server memory | One persistent Node process owns the authority |
| Presence and pending friend invitations | Server memory | Expire through leases/reservations; do not survive restart |
| Global message board | Server memory | Last 100 messages; global rather than room-private |
| Accounts and friend relationships | PostgreSQL | Verified account operations |
| Two-account match results and replays | PostgreSQL | Participants, or public viewers with both participants' consent |
| Saved AI analysis | PostgreSQL | Same current match-read permissions; participant-only generation |
| Ratings and counters | PostgreSQL | Public aggregate ranking; participant-only match deltas |
| Achievement summaries and badges | PostgreSQL | Account-owned progress; separate opt-in for public badges |
| Pending completion writes | Server memory until committed | Retried during process lifetime; unsaved work can be lost on restart |

The live service is retained during development reloads. Changes to its stored fields require a deliberate owner-managed restart; method reloads do not automatically reconstruct its state. The current architecture does not support multiple independent application replicas sharing live rooms. Restarting clears live matches, queue entries, quotas and unsaved completion work, while committed PostgreSQL records survive.

## 6. Demonstration and verification

### Fundamental demonstration

1. On Computer A, run the configured application and open a player browser. On Computer B, open the same reachable origin.
2. Use separate player identities, enter guest nicknames or sign in, and create/join a room.
3. Show welcome messages, both names, zero scores and the fully covered 6 × 6 board.
4. In a separate administrator session, show the connected-client count/list and the room.
5. Reveal cells and compare both browsers: bombs award one point and retain the deadline; empty cells display clues and pass play.
6. Let a turn expire without a move to show that the server advances play independently.
7. Finish by finding all 11 bombs, show Win/Lost and final scores, then have both players vote for rematch. Identify the previous winner as the new first player.
8. Reset the room from the operator dashboard and show covered cells and zero scores in both player browsers. Start again using the operator control.

### Extra-feature demonstration preparation

Prepare two regular accounts, a separate administrator session, a saved two-account replay and analysis, and available bot quota. Configure provider access for live AI checks. Use another browser session to demonstrate spectating and privacy boundaries. Database migrations and any required runtime activation should be completed by the server owner before the demonstration.

### Automated evidence

| Area | Existing evidence |
| --- | --- |
| Board generation, reveals, scores, timers, reset and rematch | [game.test.ts](tests/game.test.ts) |
| Isolation, ownership, matchmaking, reconnects and replay capture | [rooms.test.ts](tests/rooms.test.ts) |
| Signed identity and operator permissions | [session.test.ts](tests/session.test.ts), [operator.test.ts](tests/operator.test.ts) |
| Bot moves, provider validation and lifecycle | [bot.test.ts](tests/bot.test.ts) |
| Analysis evidence, report validation, reuse and limits | [analysis.test.ts](tests/analysis.test.ts) |
| Social presence, invitations and relationship behavior | [friends.test.ts](tests/friends.test.ts) |
| Message validation, retention and limits | [messages.test.ts](tests/messages.test.ts) |
| Badge thresholds, eligibility and persistence behavior | [achievements.test.ts](tests/achievements.test.ts) |
| Rating calculation and transactional persistence | [elo.test.ts](tests/elo.test.ts), [history.test.ts](tests/history.test.ts) |
| Real HTTP/SSE behavior against a running server | [verify-game.ts](scripts/verify-game.ts) |

`pnpm check` runs lint, TypeScript checks and the game test suite. Database-backed checks are opt-in and must not be inferred from a passing default run. Mocked AI tests establish request/response handling and game behavior, not the availability or latency of a live model.

**Verification for this document (4 November 2026):** `pnpm check` passed, including lint and TypeScript checking. The test runner reported 94 tests: 90 passed, zero failed and four opt-in database tests skipped. All 75 repository links in this document resolved to existing files. No live integration test, live AI request or two-computer demonstration was performed for this documentation change; the existing development server was left untouched.

`pnpm test:integration` requires an empty lobby on the existing server and exercises actual HTTP/SSE operation. It must not interrupt active games or require replacing the user's running server. A successful automated run also does not substitute for the two-computer classroom demonstration or instructor acceptance of the transport and address-configuration interpretations.
