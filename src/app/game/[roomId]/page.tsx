"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "~/trpc/react";
import {
  ConnectionStatus,
  GameCell,
  PageShell,
  Panel,
  PlayerScore,
  TurnTimer,
} from "~/app/_components/game/ui";
import { useGameConnection } from "~/app/_components/game/use-game-connection";
import { GlobalMessageBoard } from "~/app/_components/game/global-message-board";

export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const router = useRouter();
  const {
    room: state,
    connection,
    offset,
    error,
    setError,
    retry,
    nickname,
    setNickname,
  } = useGameConnection(roomId);
  const [elapsed, setElapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const modal = useRef<HTMLDialogElement>(null);
  const onError = (cause: { message: string }) => setError(cause.message);
  const join = api.game.join.useMutation({
    onError,
    onSuccess: () => setError(""),
  });
  const reveal = api.game.reveal.useMutation({
    onError,
    onSuccess: () => setError(""),
  });
  const rematch = api.game.rematch.useMutation({
    onError,
    onSuccess: () => setError(""),
  });
  const leave = api.game.leave.useMutation({
    onError,
    onSuccess: () => router.push("/game"),
  });
  const me = state?.players.find((p) => p.id === state.viewerId && p.seated);
  const utils = api.useUtils();
  const savedMatchId =
    state?.saveStatus === "saved" && me?.account ? state.matchId : null;
  const matchRating = api.game.matchRating.useQuery(
    { matchId: savedMatchId ?? "" },
    { enabled: !!savedMatchId, retry: false },
  );
  useEffect(() => {
    if (!savedMatchId) return;
    void utils.game.rating.invalidate();
    void utils.game.leaderboard.invalidate();
  }, [savedMatchId, utils]);
  const active = state?.players.find((p) => p.id === state.activePlayer);
  const connected = connection === "connected";
  const canReveal =
    connected &&
    state?.phase === "active" &&
    state.activePlayer === me?.id &&
    !reveal.isPending &&
    !elapsed;
  return (
    <PageShell>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold">Find the bombs. Keep the turn.</h1>
        <ConnectionStatus status={connection} />
      </div>
      <div className="mb-4 flex flex-wrap gap-3">
        <Link className="btn btn-sm" href="/game">
          Lobby
        </Link>
        <button
          className="btn btn-sm"
          onClick={() => {
            if (!navigator.clipboard) {
              setError(
                "Copy the room URL from your address bar to invite a friend.",
              );
              return;
            }
            void navigator.clipboard
              .writeText(window.location.href)
              .then(() => setCopied(true))
              .catch(() =>
                setError(
                  "Copy the room URL from your address bar to invite a friend.",
                ),
              );
          }}
        >
          {copied
            ? "Link copied"
            : state?.mode === "bot"
              ? "Copy spectator link"
              : "Copy invite link"}
        </button>
        {me && (
          <button
            className="btn btn-sm"
            onClick={() =>
              state?.phase === "active"
                ? modal.current?.showModal()
                : leave.mutate({ roomId })
            }
            disabled={leave.isPending}
          >
            Leave room
          </button>
        )}
      </div>
      {error && (
        <div className="alert alert-error mb-4" role="alert">
          <span>{error}</span>
          <button className="btn btn-sm" onClick={retry}>
            Retry connection
          </button>
        </div>
      )}
      {!state ? (
        <Panel title="Connecting to the room">
          <span className="loading loading-spinner" />
          <p>Establishing your player session…</p>
        </Panel>
      ) : state.phase === "closed" ? (
        <Panel title="Room closed">
          <p>This room has ended.</p>
          <Link className="btn btn-primary" href="/game">
            Return to lobby
          </Link>
        </Panel>
      ) : (
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="space-y-5">
            <Panel
              title={
                me
                  ? `Welcome, ${me.nickname}.`
                  : state.phase === "lobby"
                    ? "Take a seat"
                    : "Watching this game"
              }
            >
              <p role="status">{state.message}</p>
              {state.mode !== "bot" &&
                state.phase === "lobby" &&
                !me &&
                state.players.length < 2 && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      join.mutate({ roomId, nickname });
                    }}
                  >
                    <fieldset className="fieldset">
                      <legend className="fieldset-legend">Your nickname</legend>
                      <input
                        className="input w-full"
                        aria-label="Nickname"
                        value={nickname}
                        onChange={(e) => setNickname(e.target.value)}
                        maxLength={24}
                        required
                        autoComplete="nickname"
                      />
                      <button
                        className="btn btn-primary mt-2"
                        disabled={
                          !connected || join.isPending || !nickname.trim()
                        }
                      >
                        Join
                      </button>
                    </fieldset>
                  </form>
                )}
              {state.phase === "lobby" && me && (
                <p>
                  {state.manualStart
                    ? "The operator will start when both players are connected."
                    : state.mode === "bot"
                      ? "Play starts when you connect to this room."
                      : "Play starts when both players have joined and opened this room."}
                </p>
              )}
              <p className="text-sm">
                {state.mode === "bot"
                  ? "Bot practice · no saved result or replay."
                  : state.players.some((p) => !p.account)
                    ? "Guest game · no result or replay will be saved."
                    : state.phase === "lobby"
                      ? "Two-account games affect Elo and publicly list account names and ratings. A guest opponent makes this game unrated."
                      : "Rated account game · account names and ratings are public; result and replay privacy still applies."}
              </p>
              {state.phase === "active" && (
                <>
                  <p role="status" className="text-lg font-semibold">
                    {state.activePlayer === me?.id
                      ? "Your turn"
                      : active?.bot
                        ? "Bot is choosing…"
                        : `${active?.nickname}'s turn`}
                  </p>
                  <TurnTimer
                    key={state.turnId}
                    deadline={state.deadline!}
                    offset={offset}
                    onElapsed={setElapsed}
                  />
                </>
              )}
              {state.phase === "finished" && (
                <div className="space-y-3" role="status">
                  <h2 className="text-3xl font-bold">
                    {me
                      ? state.winner === me.id
                        ? "Win"
                        : "Lost"
                      : "Match finished"}
                    {state.resultReason === "forfeit" ? " · Forfeit" : ""}
                  </h2>
                  {state.saveStatus === "pending" && (
                    <p>Saving result, replay, and rating…</p>
                  )}
                  {state.saveStatus === "failed" && (
                    <p className="text-warning">
                      Result, replay, and rating have not been saved. The server
                      is retrying.
                    </p>
                  )}
                  {savedMatchId && matchRating.isPending && (
                    <p>Loading rating change…</p>
                  )}
                  {savedMatchId && matchRating.error && (
                    <p role="alert">
                      Unable to load rating change.{" "}
                      <button
                        className="btn btn-sm"
                        onClick={() => void matchRating.refetch()}
                      >
                        Retry
                      </button>
                    </p>
                  )}
                  {savedMatchId && matchRating.data && (
                    <p>
                      {matchRating.data.before} → {matchRating.data.after} Elo (
                      {matchRating.data.delta >= 0 ? "+" : ""}
                      {matchRating.data.delta})
                    </p>
                  )}
                  {state.saveStatus === "saved" && (
                    <Link
                      className="link"
                      href={`/game/replay/${state.matchId}`}
                    >
                      Watch saved replay
                    </Link>
                  )}
                  {me &&
                    state.resultReason === "completed" &&
                    state.players.every((p) => p.seated) && (
                      <>
                        <button
                          className="btn btn-primary"
                          disabled={
                            !connected ||
                            rematch.isPending ||
                            state.rematchVotes.includes(me.id)
                          }
                          onClick={() =>
                            rematch.mutate({ roomId, matchId: state.matchId })
                          }
                        >
                          Rematch
                        </button>
                        <p>
                          {state.mode === "bot"
                            ? "The bot accepts automatically · rematches use the shared hourly limit."
                            : `${state.rematchVotes.length}/2 votes`}{" "}
                          The previous winner starts.
                        </p>
                      </>
                    )}
                  {me && (
                    <button
                      className="btn"
                      disabled={leave.isPending}
                      onClick={() => leave.mutate({ roomId })}
                    >
                      Return to lobby
                    </button>
                  )}
                </div>
              )}
              {state.phase !== "lobby" && (
                <>
                  <div
                    className="grid grid-cols-6 gap-2"
                    aria-label="Six by six bomb board"
                  >
                    {state.cells.map((cell, index) => (
                      <GameCell
                        key={index}
                        cell={cell}
                        index={index}
                        disabled={!canReveal}
                        onReveal={() =>
                          reveal.mutate({
                            roomId,
                            matchId: state.matchId,
                            turnId: state.turnId,
                            cellIndex: index,
                          })
                        }
                      />
                    ))}
                  </div>
                  <p className="text-sm">
                    ? Covered · ✹ Bomb · Number: neighboring bombs
                  </p>
                </>
              )}
            </Panel>
          </div>
          <aside className="min-w-0 space-y-5">
            <Panel title="Players">
              {state.players.map((player) => (
                <PlayerScore
                  key={player.id}
                  player={player}
                  active={state.activePlayer === player.id}
                  own={me?.id === player.id}
                />
              ))}
              {state.players.length < 2 && (
                <p>{2 - state.players.length} open seat</p>
              )}
            </Panel>
            <GlobalMessageBoard />
          </aside>
        </div>
      )}
      <section className="mt-6 text-sm" aria-label="How to play">
        <p>
          <strong>How to play:</strong> Choose a covered cell on your turn. A
          bomb scores one point and keeps the original deadline. An empty cell
          or timeout passes play. Find all 11 bombs; most points wins.
        </p>
        <p className="mt-1">
          Leaving active play forfeits the match. After a connection is lost,
          your seat is reserved for 15 seconds. Keep this room open.
        </p>
      </section>
      <dialog ref={modal} className="modal" aria-labelledby="leave-title">
        <div className="modal-box">
          <h2 id="leave-title" className="text-lg font-bold">
            Leave and forfeit?
          </h2>
          <p className="py-4">
            Your opponent will win this match. Account-only games save the
            forfeit and replay.
          </p>
          <div className="modal-action">
            <button className="btn" onClick={() => modal.current?.close()}>
              Cancel
            </button>
            <button
              className="btn"
              disabled={leave.isPending}
              onClick={() => leave.mutate({ roomId })}
            >
              Leave game
            </button>
          </div>
        </div>
        <form method="dialog" className="modal-backdrop">
          <button>Cancel</button>
        </form>
      </dialog>
    </PageShell>
  );
}
