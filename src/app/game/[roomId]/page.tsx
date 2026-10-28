"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useRef, useState } from "react";
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
          {copied ? "Link copied" : "Copy invite link"}
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
              {state.phase === "lobby" && !me && state.players.length < 2 && (
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
                    : "Play starts when both players have joined and opened this room."}
                </p>
              )}
              <p className="text-sm">
                {state.players.some((p) => !p.account)
                  ? "Guest game · no result or replay will be saved."
                  : state.phase === "lobby"
                    ? "Two account players save a result and replay. A guest opponent makes this game unrecorded."
                    : "Account game · result and replay are recorded."}
              </p>
              {state.phase === "active" && (
                <>
                  <p role="status" className="text-lg font-semibold">
                    {state.activePlayer === me?.id
                      ? "Your turn"
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
                    <p>Saving result and replay…</p>
                  )}
                  {state.saveStatus === "failed" && (
                    <p className="text-warning">
                      Result and replay have not been saved. The server is
                      retrying.
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
                          {state.rematchVotes.length}/2 votes · the previous
                          winner starts.
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
          <aside className="space-y-5">
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
            <Panel title="How to play">
              <ol className="list-decimal space-y-2 pl-5 text-sm">
                <li>Choose a covered cell on your turn.</li>
                <li>
                  A bomb scores one point and keeps the original deadline.
                </li>
                <li>An empty cell or timeout passes play.</li>
                <li>Find all 11 bombs. Most points wins.</li>
              </ol>
              <p className="text-sm">
                Leaving active play forfeits the match. After a connection is
                lost, your seat is reserved for 15 seconds. Keep this room open.
              </p>
            </Panel>
          </aside>
        </div>
      )}
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
