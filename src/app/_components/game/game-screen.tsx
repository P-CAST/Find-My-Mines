"use client";
import { useState } from "react";
import { api } from "~/trpc/react";
import {
  ConnectionStatus,
  GameCell,
  PageShell,
  Panel,
  PlayerScore,
  TurnTimer,
} from "./ui";
import { useGame } from "./use-game";

export function GameScreen() {
  const { session, state, connection, offset, error, setError, retry } =
    useGame();
  const [nickname, setNickname] = useState("");
  const [elapsed, setElapsed] = useState(false);
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
  const me = state?.players.find((p) => p.id === session.data?.id);
  const connected = connection === "connected";
  const canReveal =
    connected &&
    state?.phase === "active" &&
    state.activePlayer === me?.id &&
    !reveal.isPending &&
    !elapsed;
  const activeName = state?.players.find(
    (p) => p.id === state.activePlayer,
  )?.nickname;
  return (
    <PageShell>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">Find the bombs. Keep the turn.</h1>
          <p className="mt-2">
            Every bomb is a point. An empty cell passes play.
          </p>
        </div>
        <ConnectionStatus
          status={session.error ? "disconnected" : connection}
        />
      </div>
      {(error || session.error) && (
        <div role="alert" className="alert alert-error mb-4">
          <span>{error || session.error?.message}</span>
          <button
            className="btn btn-sm"
            onClick={() => {
              setError("");
              retry();
            }}
          >
            Retry connection
          </button>
        </div>
      )}
      {!state ? (
        <Panel title="Connecting to the game">
          <span className="loading loading-spinner" />
          <p>Establishing your player session…</p>
        </Panel>
      ) : (
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="space-y-5">
            {state.phase === "lobby" && (
              <Panel title={me ? `Welcome, ${me.nickname}.` : "Take a seat"}>
                <p role="status">{state.message}</p>
                {!me && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      join.mutate({ nickname });
                    }}
                  >
                    <fieldset className="fieldset">
                      <legend className="fieldset-legend">Your nickname</legend>
                      <input
                        className="input w-full"
                        aria-label="Nickname"
                        value={nickname}
                        onChange={(event) => setNickname(event.target.value)}
                        maxLength={24}
                        required
                        autoComplete="nickname"
                      />
                      <p className="label">
                        1–24 characters. No sign-in required.
                      </p>
                      <button
                        className="btn btn-primary mt-2"
                        disabled={
                          !connected ||
                          join.isPending ||
                          !nickname.trim() ||
                          state.players.length === 2
                        }
                      >
                        {join.isPending ? (
                          <span className="loading loading-spinner loading-sm" />
                        ) : (
                          "Join"
                        )}
                      </button>
                      {state.players.length === 2 && (
                        <p className="text-error">
                          Game full. Both seats are reserved.
                        </p>
                      )}
                    </fieldset>
                  </form>
                )}
                {me && (
                  <p>
                    {state.manualStart
                      ? "The operator will start when both players are connected."
                      : "The match starts automatically when the second player joins."}
                  </p>
                )}
              </Panel>
            )}
            {state.phase !== "lobby" && (
              <Panel
                title={me ? `Welcome, ${me.nickname}.` : "Match in progress"}
              >
                {!me && (
                  <div className="alert alert-info">
                    Game full. You can watch this match.
                  </div>
                )}
                {state.phase === "active" ? (
                  <>
                    <p role="status" className="text-lg font-semibold">
                      {state.activePlayer === me?.id
                        ? "Your turn"
                        : `${activeName}'s turn`}
                    </p>
                    <TurnTimer
                      key={state.turnId}
                      deadline={state.deadline!}
                      offset={offset}
                      onElapsed={setElapsed}
                    />
                  </>
                ) : (
                  <div className="space-y-3" role="status">
                    <h2 className="text-3xl font-bold">
                      {me
                        ? state.winner === me.id
                          ? "Win"
                          : "Lost"
                        : "Match finished"}
                    </h2>
                    <p>{state.message}</p>
                    {me && (
                      <button
                        className="btn btn-primary"
                        disabled={
                          !connected ||
                          rematch.isPending ||
                          state.rematchVotes.includes(me.id)
                        }
                        onClick={() =>
                          rematch.mutate({ matchId: state.matchId })
                        }
                      >
                        Rematch
                      </button>
                    )}
                    <p>
                      {state.rematchVotes.length}/2 players voted for a rematch.
                      The previous winner starts.
                    </p>
                  </div>
                )}
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
              </Panel>
            )}
          </div>
          <aside className="space-y-5">
            <Panel title="Players">
              <div className="space-y-3">
                {state.players.map((player) => (
                  <PlayerScore
                    key={player.id}
                    player={player}
                    active={player.id === state.activePlayer}
                    own={player.id === me?.id}
                  />
                ))}
                {state.players.length < 2 && (
                  <div className="alert">
                    {2 - state.players.length} open seat
                    {state.players.length === 0 ? "s" : ""}
                  </div>
                )}
              </div>
            </Panel>
            <Panel title="How to play">
              <ol className="list-decimal space-y-2 pl-5 text-sm">
                <li>Choose a covered cell on your turn.</li>
                <li>
                  Find a bomb: score 1 and keep playing within your original 10
                  seconds.
                </li>
                <li>
                  Find an empty cell or run out of time: the opponent gets 10
                  seconds.
                </li>
                <li>Find all 11 bombs to finish. Most points wins.</li>
              </ol>
              <p className="text-sm">
                A lost connection reserves your seat for 15 seconds after
                detection. Keep this page open.
              </p>
            </Panel>
          </aside>
        </div>
      )}
    </PageShell>
  );
}
