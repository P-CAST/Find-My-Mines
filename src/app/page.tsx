"use client";

import Link from "next/link";
import { useState } from "react";

export default function Home() {
  const [mode, setMode] = useState<"guest" | "login">("guest");

  return (
    <main className="hero bg-base-200 text-base-content min-h-[calc(100dvh-4rem)]">
      <div className="hero-content w-full max-w-5xl flex-col gap-10 px-4 py-12 sm:px-8 lg:flex-row-reverse lg:gap-16">
        <div className="text-center lg:text-left">
          <p className="text-primary mb-3 font-semibold">Find My Mines</p>
          <h1 className="text-4xl font-bold sm:text-5xl">
            Find the bombs. Keep the turn.
          </h1>
          <p className="py-6 text-lg">
            Challenge a friend in a race to uncover 11 hidden bombs. Every bomb
            earns a point and keeps your turn. Hit an empty cell, and play
            passes to your opponent.
          </p>
          <p className="text-sm">
            Two players · 36 cells · 11 bombs · 10 seconds per turn
          </p>
        </div>
        <div className="card bg-base-100 w-full max-w-sm shrink-0 shadow-2xl">
          <div className="card-body gap-6">
            <div
              role="tablist"
              aria-label="Choose how to play"
              className="tabs tabs-box"
            >
              {(["guest", "login"] as const).map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  id={`${tab}-tab`}
                  aria-controls={`${tab}-panel`}
                  aria-selected={mode === tab}
                  tabIndex={mode === tab ? 0 : -1}
                  className={`tab flex-1 focus-visible:outline-2 ${mode === tab ? "tab-active" : ""}`}
                  onClick={() => setMode(tab)}
                  onKeyDown={(event) => {
                    if (
                      !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                        event.key,
                      )
                    )
                      return;
                    event.preventDefault();
                    const next =
                      event.key === "Home"
                        ? "guest"
                        : event.key === "End"
                          ? "login"
                          : tab === "guest"
                            ? "login"
                            : "guest";
                    setMode(next);
                    document.getElementById(`${next}-tab`)?.focus();
                  }}
                >
                  {tab === "guest" ? "Play as guest" : "Login"}
                </button>
              ))}
            </div>
            <section
              id="guest-panel"
              role="tabpanel"
              aria-labelledby="guest-tab"
              hidden={mode !== "guest"}
              tabIndex={0}
              className="space-y-4 focus-visible:outline-2"
            >
              <h2 className="card-title">Ready to play?</h2>
              <p>
                No account needed. Choose a nickname in the lobby and take a
                seat.
              </p>
              <p>Find the most bombs to win.</p>
              <Link href="/game" className="btn btn-primary w-full">
                Play
              </Link>
            </section>
            <section
              id="login-panel"
              role="tabpanel"
              aria-labelledby="login-tab"
              hidden={mode !== "login"}
              tabIndex={0}
              className="space-y-4 focus-visible:outline-2"
            >
              <h2 className="card-title">Login</h2>
              <p id="login-notice">
                Account login is coming soon. Play as a guest to get started.
              </p>
              <fieldset className="fieldset" aria-describedby="login-notice">
                <label className="label" htmlFor="login-email">
                  Email
                </label>
                <input
                  id="login-email"
                  type="email"
                  className="input w-full"
                  placeholder="Email"
                  autoComplete="email"
                />
                <label className="label" htmlFor="login-password">
                  Password
                </label>
                <input
                  id="login-password"
                  type="password"
                  className="input w-full"
                  placeholder="Password"
                  autoComplete="current-password"
                />
                <button type="button" className="btn btn-neutral mt-4" disabled>
                  Login
                </button>
              </fieldset>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}
