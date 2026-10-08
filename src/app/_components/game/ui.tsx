"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import type { GameSnapshot, PublicCell } from "~/server/game/service";

export function PageShell({ children }: { children: ReactNode }) {
  return (
    <main className="bg-base-200 text-base-content min-h-screen">
      <div className="mx-auto max-w-5xl px-4 py-6 sm:px-8">
        <header className="mb-8 flex flex-wrap items-center justify-between gap-3">
          <Link href="/" className="text-2xl font-bold focus-visible:outline-2">
            Find My Mines
          </Link>
          <nav className="flex gap-2" aria-label="Main">
            <Link href="/" className="btn btn-ghost btn-sm">
              Play
            </Link>
            <Link href="/operator" className="btn btn-ghost btn-sm">
              Operator
            </Link>
          </nav>
        </header>
        {children}
        <footer className="mt-8 text-sm">
          Two players · 36 cells · 11 bombs · 10 seconds per turn
        </footer>
      </div>
    </main>
  );
}
export function Panel({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="card border-base-300 bg-base-100 border shadow-sm">
      <div className="card-body gap-4">
        <h2 className="card-title">{title}</h2>
        {children}
      </div>
    </section>
  );
}
export type Connection = "connected" | "reconnecting" | "disconnected";
export function ConnectionStatus({ status }: { status: Connection }) {
  return (
    <span
      role="status"
      className={`badge ${status === "connected" ? "badge-success" : status === "reconnecting" ? "badge-warning" : "badge-error"}`}
    >
      {status === "reconnecting" && (
        <span className="loading loading-spinner loading-xs" />
      )}
      {status === "connected"
        ? "Connected"
        : status === "reconnecting"
          ? "Reconnecting"
          : "Disconnected"}
    </span>
  );
}
export function PlayerScore({
  player,
  active,
  own,
}: {
  player: GameSnapshot["players"][number];
  active: boolean;
  own: boolean;
}) {
  return (
    <div
      className={`stats w-full border ${active ? "border-primary" : "border-base-300"}`}
    >
      <div className="stat p-4">
        <div className="stat-title break-words whitespace-normal">
          {player.nickname}
          {own ? " (you)" : ""}
        </div>
        <div className="stat-value text-primary">{player.score}</div>
        <div className="stat-desc">
          {!player.connected
            ? "Reconnecting · seat reserved"
            : active
              ? "▶ Current player"
              : "Ready"}
        </div>
      </div>
    </div>
  );
}
export function GameCell({
  cell,
  index,
  disabled,
  onReveal,
}: {
  cell: PublicCell;
  index: number;
  disabled: boolean;
  onReveal: () => void;
}) {
  const description =
    cell.kind === "covered"
      ? "covered"
      : cell.kind === "bomb"
        ? "bomb"
        : `empty, ${cell.adjacent} adjacent bombs`;
  return (
    <button
      type="button"
      aria-label={`Row ${Math.floor(index / 6) + 1}, column ${(index % 6) + 1}: ${description}`}
      disabled={disabled || cell.kind !== "covered"}
      onClick={onReveal}
      className={`btn focus-visible:outline-primary aspect-square h-auto min-h-0 w-full p-0 text-lg focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-100 sm:text-2xl ${cell.kind === "bomb" ? "bg-success text-success-content disabled:bg-success disabled:text-success-content" : cell.kind === "empty" ? "bg-base-200 text-base-content disabled:bg-base-200 disabled:text-base-content" : "btn-outline disabled:border-base-300 disabled:bg-base-100 disabled:text-base-content"}`}
    >
      {cell.kind === "covered"
        ? "?"
        : cell.kind === "bomb"
          ? "✹"
          : cell.adjacent}
    </button>
  );
}
export function TurnTimer({
  deadline,
  offset,
  onElapsed,
}: {
  deadline: number;
  offset: number;
  onElapsed?: (expired: boolean) => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 100);
    return () => clearInterval(timer);
  }, [deadline]);
  const remaining = Math.max(0, deadline - (now + offset));
  useEffect(() => {
    onElapsed?.(remaining === 0);
  }, [remaining, onElapsed]);
  return (
    <div>
      <div className="mb-2 flex justify-between gap-2">
        <span>Turn time</span>
        <span className="font-mono tabular-nums">
          {(remaining / 1000).toFixed(1)}s
        </span>
      </div>
      <progress
        className="progress progress-primary w-full"
        value={remaining}
        max={10000}
        aria-label="Time remaining in this turn"
      />
      <p className="text-xs">
        Finding a bomb keeps your turn and the same deadline.
      </p>
    </div>
  );
}
