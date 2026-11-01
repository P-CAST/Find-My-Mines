"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "~/trpc/react";
import { authClient } from "~/server/better-auth/client";
import type { ReplayFrame } from "~/server/game/service";
import {
  GameCell,
  PageShell,
  Panel,
  PlayerScore,
} from "~/app/_components/game/ui";

export default function ReplayPage() {
  const { matchId } = useParams<{ matchId: string }>();
  const { data: account, isPending: accountPending } = authClient.useSession();
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
        <div className="grid grid-cols-1 gap-5 md:grid-cols-[minmax(0,1fr)_18rem]">
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
          {!accountPending && (
            <div className="min-w-0 [overflow-wrap:anywhere] md:col-span-2">
              <AnalysisPanel
                key={`${matchId}:${account?.user.id ?? "guest"}`}
                matchId={matchId}
                frames={frames}
                names={[result.data.playerOneName, result.data.playerTwoName]}
                seek={seek}
              />
            </div>
          )}
        </div>
      )}
    </PageShell>
  );
}

function AnalysisPanel({
  matchId,
  frames,
  names,
  seek,
}: {
  matchId: string;
  frames: ReplayFrame[];
  names: [string, string];
  seek: (index: number) => void;
}) {
  const analysis = api.game.analysis.useQuery({ matchId }, { retry: false });
  const generate = api.game.generateAnalysis.useMutation({
    retry: false,
    onSuccess: () => {
      void analysis.refetch();
    },
  });
  const saved = analysis.error ? null : analysis.data?.saved;
  return (
    <Panel title="AI game analysis">
      <p className="text-sm">
        AI-generated coaching based on recorded events. It does not establish
        optimal moves or exact probabilities.
      </p>
      {analysis.isPending ? (
        <p role="status">Loading analysis…</p>
      ) : analysis.error ? (
        <div className="space-y-2">
          <p className="text-error" role="alert">
            {analysis.error.message}
          </p>
          <button className="btn" onClick={() => void analysis.refetch()}>
            Retry loading analysis
          </button>
        </div>
      ) : saved ? (
        <>
          <p className="text-sm">
            Generated {saved.generatedAt.toLocaleString()} · Saved report
          </p>
          <p className="whitespace-pre-wrap">{saved.document.report.summary}</p>
          <div className="overflow-x-auto">
            <table className="table">
              <caption className="text-left font-semibold">
                Recorded match statistics
              </caption>
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Score</th>
                  <th>Bombs found</th>
                  <th>Empty cells</th>
                  <th>Timeouts</th>
                  <th>Longest scoring run</th>
                </tr>
              </thead>
              <tbody>
                {saved.document.statistics.players.map((player) => (
                  <tr key={player.seat}>
                    <td>
                      Player {player.seat + 1}: {names[player.seat]}
                    </td>
                    <td>{player.score}</td>
                    <td>{player.bombs}</td>
                    <td>{player.emptyCells}</td>
                    <td>{player.timeouts}</td>
                    <td>{player.longestScoringRun}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm">
            {saved.document.statistics.turnChanges} turn changes ·{" "}
            {(saved.document.statistics.durationMs / 1000).toFixed(1)}s ·{" "}
            {saved.document.statistics.reason === "forfeit"
              ? "Forfeit"
              : "All bombs found"}
          </p>
          {!!saved.document.report.keyMoments.length && (
            <h3 className="font-semibold">Key moments</h3>
          )}
          <ul className="space-y-3">
            {saved.document.report.keyMoments.map((moment, i) => {
              const frameIndex = frames.findIndex(
                (item) => item.sequence === moment.sequence,
              );
              const frame = frames[frameIndex];
              return (
                <li key={i} className="space-y-1">
                  <button
                    className="btn btn-sm"
                    disabled={!frame}
                    onClick={() => seek(frameIndex)}
                  >
                    Event {moment.sequence + 1}
                    {frame ? ` · ${(frame.elapsedMs / 1000).toFixed(1)}s` : ""}
                  </button>
                  <p className="whitespace-pre-wrap">{moment.explanation}</p>
                </li>
              );
            })}
          </ul>
          {saved.document.report.coaching.map((player) => (
            <div key={player.seat}>
              <h3 className="font-semibold">
                Player {player.seat + 1}: {names[player.seat]}
              </h3>
              <ul className="list-disc space-y-1 pl-5">
                {player.tips.map((tip, i) => (
                  <li key={i} className="whitespace-pre-wrap">
                    {tip}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </>
      ) : (
        <>
          {!analysis.data?.available ? (
            <p>
              AI analysis is not configured. Saved reports remain available.
            </p>
          ) : !analysis.data.canGenerate ? (
            <p>A match participant can generate a report for this replay.</p>
          ) : (
            <>
              <p>
                Analyzing sends anonymized replay events to OpenAI. The saved
                report follows this replay’s privacy settings.
              </p>
              <button
                className="btn self-start"
                disabled={generate.isPending}
                onClick={() => generate.mutate({ matchId })}
              >
                {generate.isPending
                  ? "Analyzing…"
                  : generate.error
                    ? "Retry analysis"
                    : "Analyze game"}
              </button>
            </>
          )}
          {generate.isPending && (
            <p role="status">
              Generating coaching. You can continue watching the replay.
            </p>
          )}
          {generate.error && (
            <p className="text-error" role="alert">
              {generate.error.message}
            </p>
          )}
        </>
      )}
    </Panel>
  );
}
