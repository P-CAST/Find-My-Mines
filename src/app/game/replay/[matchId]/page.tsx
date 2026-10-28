"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "~/trpc/react";
import {
  GameCell,
  PageShell,
  Panel,
  PlayerScore,
} from "~/app/_components/game/ui";

export default function ReplayPage() {
  const { matchId } = useParams<{ matchId: string }>();
  const result = api.game.replay.useQuery({ matchId }, { retry: false });
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const frames = result.data?.replay.frames;
  const frame = frames?.[index];
  useEffect(() => {
    setIndex(0);
    setPlaying(false);
  }, [matchId]);
  useEffect(() => {
    if (!playing || !frames || !frame) return;
    const next = frames[index + 1];
    if (!next) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(
      () => setIndex((i) => i + 1),
      Math.max(50, (next.elapsedMs - frame.elapsedMs) / speed),
    );
    return () => clearTimeout(timer);
  }, [playing, frames, frame, index, speed]);
  const seek = (next: number) => {
    setPlaying(false);
    setIndex(next);
  };
  return (
    <PageShell>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold">Game replay</h1>
        <Link className="btn btn-sm" href="/game/history">
          My history
        </Link>
        <Link className="btn btn-sm" href="/game">
          Lobby
        </Link>
      </div>
      {result.isPending ? (
        <p role="status">Loading replay…</p>
      ) : result.error ? (
        <div className="alert alert-error" role="alert">
          {result.error.message}
        </div>
      ) : !frame || result.data.replay.version !== 1 ? (
        <p>This replay format is unavailable.</p>
      ) : (
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_18rem]">
          <Panel
            title={`${result.data.playerOneName} vs ${result.data.playerTwoName}`}
          >
            <p>
              {result.data.reason === "forfeit" ? "Forfeit win" : "Winner"}:{" "}
              {result.data.winnerSeat === 0
                ? result.data.playerOneName
                : result.data.playerTwoName}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                className="btn"
                disabled={index === 0}
                onClick={() => seek(index - 1)}
              >
                Previous
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  if (index === frames.length - 1) setIndex(0);
                  setPlaying((p) => !p);
                }}
              >
                {playing ? "Pause" : "Play"}
              </button>
              <button
                className="btn"
                disabled={index === frames.length - 1}
                onClick={() => seek(index + 1)}
              >
                Next
              </button>
              <label className="label">
                Speed
                <select
                  className="select select-sm"
                  value={speed}
                  onChange={(e) => setSpeed(Number(e.target.value))}
                >
                  <option value={1}>1×</option>
                  <option value={2}>2×</option>
                  <option value={4}>4×</option>
                </select>
              </label>
            </div>
            <label className="fieldset">
              <span className="fieldset-legend">
                Replay position · event {index + 1} of {frames.length}
              </span>
              <input
                type="range"
                className="range range-primary"
                min={0}
                max={frames.length - 1}
                value={index}
                onChange={(e) => seek(Number(e.target.value))}
              />
            </label>
            <p role="status">
              {(frame.elapsedMs / 1000).toFixed(1)}s · {frame.event}
              {frame.cellIndex !== undefined
                ? ` · row ${Math.floor(frame.cellIndex / 6) + 1}, column ${(frame.cellIndex % 6) + 1}`
                : ""}
            </p>
            <div className="grid grid-cols-6 gap-2" aria-label="Replay board">
              {frame.state.cells.map((cell, i) => (
                <GameCell
                  key={i}
                  cell={cell}
                  index={i}
                  disabled
                  onReveal={() => undefined}
                />
              ))}
            </div>
            <p className="text-sm">
              Only cells revealed during the match are shown. Unrevealed bombs
              stay hidden, including after a forfeit.
            </p>
          </Panel>
          <Panel title="Players at this moment">
            {frame.state.players.map((player) => (
              <PlayerScore
                key={player.id}
                player={player}
                active={frame.state.activePlayer === player.id}
                own={false}
              />
            ))}
            {frame.state.deadline !== null && (
              <p>
                Time remaining at this event:{" "}
                {(
                  Math.max(0, frame.state.deadline - frame.elapsedMs) / 1000
                ).toFixed(1)}
                s
              </p>
            )}
          </Panel>
        </div>
      )}
    </PageShell>
  );
}
