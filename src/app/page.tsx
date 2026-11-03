"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "~/trpc/react";
import { authClient } from "~/server/better-auth/client";

export default function Home() {
  const [mode, setMode] = useState<"guest" | "login">("guest");
  useEffect(() => {
    if (
      new URLSearchParams(window.location.search).get("returnTo") ===
      "/operator"
    )
      setMode("login");
  }, []);
  const [registering, setRegistering] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const {
    data: session,
    isPending,
    error: sessionError,
    refetch,
  } = authClient.useSession();

  const guestSession = api.game.session.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
    enabled: !isPending && !session,
  });
  const saveGuestName = api.game.setGuestName.useMutation();
  const destination = () => {
    const target = new URLSearchParams(window.location.search).get("returnTo");
    return target &&
      (target === "/operator" || /^\/game(?:\/[a-f0-9-]{36})?$/.test(target))
      ? target
      : "/game";
  };
  const playGuest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current) return;
    const name = new FormData(event.currentTarget).get("nickname");
    const nickname = typeof name === "string" ? name.trim() : "";
    if (
      !guestSession.data?.nickname &&
      (!nickname || nickname.length > 24 || /[\p{C}]/u.test(nickname))
    ) {
      setError("Choose a name with 1–24 visible characters.");
      return;
    }
    submitting.current = true;
    setPending(true);
    setError("");
    try {
      if (!guestSession.data?.nickname) {
        await saveGuestName.mutateAsync({ nickname });
      }
      window.location.assign(destination());
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Unable to save your name. Please try again.",
      );
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const emailField = fields.get("email");
    const passwordField = fields.get("password");
    const nameField = fields.get("name");
    const email = typeof emailField === "string" ? emailField.trim() : "";
    const password = typeof passwordField === "string" ? passwordField : "";
    const name = typeof nameField === "string" ? nameField.trim() : "";
    if (registering && (!name || /[\p{C}]/u.test(name))) {
      setError("Choose a name with 1–24 visible characters.");
      return;
    }
    submitting.current = true;
    setPending(true);
    setError("");
    try {
      const result = registering
        ? await authClient.signUp.email({ email, password, name })
        : await authClient.signIn.email({ email, password });
      if (result.error) {
        setError(
          result.error.message ?? "Unable to sign in. Please try again.",
        );
        return;
      }
      form.reset();
      window.location.assign(destination());
    } catch {
      setError(
        "Unable to reach the server. Check your connection and try again.",
      );
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

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
            {session ? (
              <section className="space-y-4">
                <h2 className="card-title break-words">
                  Welcome, {session.user.name}.
                </h2>
                <p>
                  Your account name is used in games and the global message
                  board.
                </p>
                <button
                  className="btn btn-primary w-full"
                  onClick={() => window.location.assign(destination())}
                >
                  Play
                </button>
              </section>
            ) : (
              <>
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
                      disabled={pending}
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
                    No account needed. Your guest name is used in games and the
                    global message board for this session.
                  </p>
                  {isPending || guestSession.isPending ? (
                    <p role="status">Checking your session…</p>
                  ) : sessionError || guestSession.error ? (
                    <div className="alert alert-error" role="alert">
                      <span>Unable to check your session.</span>
                      <button
                        className="btn btn-sm"
                        onClick={() => {
                          void refetch();
                          void guestSession.refetch();
                        }}
                      >
                        Retry
                      </button>
                    </div>
                  ) : (
                    <form onSubmit={playGuest} aria-busy={pending}>
                      <fieldset className="fieldset" disabled={pending}>
                        {guestSession.data?.nickname ? (
                          <p>
                            Playing as{" "}
                            <strong>{guestSession.data.nickname}</strong>
                          </p>
                        ) : (
                          <>
                            <label className="label" htmlFor="guest-name">
                              Guest name
                            </label>
                            <input
                              id="guest-name"
                              name="nickname"
                              className="input w-full"
                              autoComplete="nickname"
                              maxLength={24}
                              required
                            />
                          </>
                        )}
                        {error && (
                          <p className="text-error" role="alert">
                            {error}
                          </p>
                        )}
                        <button
                          type="submit"
                          className="btn btn-primary mt-4 w-full"
                          disabled={pending}
                        >
                          {pending ? "Please wait…" : "Play"}
                        </button>
                      </fieldset>
                    </form>
                  )}
                </section>
                <section
                  id="login-panel"
                  role="tabpanel"
                  aria-labelledby="login-tab"
                  hidden={mode !== "login"}
                  tabIndex={0}
                  className="space-y-4 focus-visible:outline-2"
                >
                  <h2 className="card-title">
                    {registering ? "Create account" : "Login"}
                  </h2>
                  {isPending ? (
                    <p role="status" className="flex items-center gap-2">
                      <span
                        className="loading loading-spinner loading-sm"
                        aria-hidden="true"
                      />
                      Checking your account…
                    </p>
                  ) : sessionError ? (
                    <div role="alert" className="alert alert-error">
                      <span>
                        Unable to check your account. Please try again.
                      </span>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => void refetch()}
                      >
                        Retry
                      </button>
                    </div>
                  ) : (
                    <form onSubmit={submit} aria-busy={pending}>
                      <fieldset className="fieldset" disabled={pending}>
                        {registering && (
                          <>
                            <label className="label" htmlFor="register-name">
                              Name
                            </label>
                            <input
                              id="register-name"
                              name="name"
                              type="text"
                              className="input w-full"
                              autoComplete="nickname"
                              maxLength={24}
                              required
                            />
                          </>
                        )}
                        <label className="label" htmlFor="login-email">
                          Email
                        </label>
                        <input
                          id="login-email"
                          name="email"
                          type="email"
                          className="input w-full"
                          placeholder="Email"
                          autoComplete="email"
                          required
                        />
                        <label className="label" htmlFor="login-password">
                          Password
                        </label>
                        <input
                          id="login-password"
                          name="password"
                          type="password"
                          className="input w-full"
                          placeholder="Password"
                          autoComplete={
                            registering ? "new-password" : "current-password"
                          }
                          minLength={registering ? 8 : undefined}
                          maxLength={128}
                          aria-describedby={
                            registering ? "password-help" : undefined
                          }
                          required
                        />
                        {registering && (
                          <p id="password-help">Use 8–128 characters.</p>
                        )}
                        {error && (
                          <p role="alert" className="text-error">
                            {error}
                          </p>
                        )}
                        <button
                          type="submit"
                          className="btn btn-primary mt-4"
                          disabled={pending}
                        >
                          {pending && (
                            <span
                              className="loading loading-spinner loading-sm"
                              aria-hidden="true"
                            />
                          )}
                          {pending
                            ? "Please wait…"
                            : registering
                              ? "Create account"
                              : "Login"}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => {
                            setRegistering(!registering);
                            setError("");
                          }}
                        >
                          {registering ? "Back to login" : "Create account"}
                        </button>
                      </fieldset>
                    </form>
                  )}
                </section>
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
