"use client";

import "~/styles/globals.css";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Geist } from "next/font/google";

import { api } from "~/trpc/react";
import { TRPCReactProvider } from "~/trpc/react";
import { isOperator } from "~/lib/operator";
import { authClient } from "~/server/better-auth/client";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
});

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const drawer = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const {
    data: session,
    isPending,
    error: sessionError,
    refetch,
  } = authClient.useSession();
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const signingOut = useRef(false);

  const logout = async () => {
    if (signingOut.current) return;
    signingOut.current = true;
    setLoggingOut(true);
    setLogoutError("");
    try {
      const result = await authClient.signOut();
      if (result.error) {
        setLogoutError(
          result.error.message ?? "Unable to log out. Please try again.",
        );
        return;
      }
      // A full navigation also clears any account-specific query data in memory.
      window.location.assign("/");
    } catch {
      setLogoutError(
        "Unable to reach the server. Check your connection and try again.",
      );
    } finally {
      signingOut.current = false;
      setLoggingOut(false);
    }
  };

  const close = () => {
    setOpen(false);
    // Restore focus after React removes inert from the page.
    requestAnimationFrame(() => trigger.current?.focus());
  };

  useEffect(() => {
    if (!open) return;
    // Wait for DaisyUI to make the drawer visible before moving focus.
    const frame = requestAnimationFrame(() => {
      drawer.current?.querySelector<HTMLButtonElement>("button")?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <html lang="en" data-theme="corporate" className={`${geist.variable}`}>
      <head>
        <title>Find My Mines</title>
        <meta
          name="description"
          content="A two-player race to find 11 bombs."
        />
        <link rel="icon" href="/favicon.ico" />
      </head>
      <body>
        <TRPCReactProvider>
          <div className="drawer text-base-content">
            <input
              type="checkbox"
              className="drawer-toggle"
              checked={open}
              readOnly
              tabIndex={-1}
              aria-hidden="true"
            />
            <div className="drawer-content" inert={open}>
              <header className="navbar bg-base-100 h-16 w-full">
                <div className="flex-1">
                  <button
                    ref={trigger}
                    type="button"
                    className="btn btn-square btn-ghost"
                    aria-label="Open navigation"
                    aria-controls="site-drawer"
                    aria-expanded={open}
                    onClick={() => setOpen(true)}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                      className="h-6 w-6 stroke-current"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="M4 6h16M4 12h16M4 18h16"
                      />
                    </svg>
                  </button>
                </div>
                <Link
                  href="/"
                  className="text-xl font-bold focus-visible:outline-2 sm:text-2xl"
                >
                  Find My Mines
                </Link>
                <div className="flex-1" />
              </header>
              {session && <SocialConnection key={session.user.id} />}
              {children}
            </div>
            <div
              id="site-drawer"
              ref={drawer}
              className="drawer-side z-30 transition-none"
              role="dialog"
              aria-label="Site navigation"
              aria-modal={open || undefined}
              inert={!open}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  close();
                }
                if (event.key === "Tab") {
                  const controls =
                    drawer.current?.querySelectorAll<HTMLElement>(
                      "button:not(:disabled), a[href]",
                    );
                  const first = controls?.[0];
                  const last = controls?.[controls.length - 1];
                  if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last?.focus();
                  } else if (
                    !event.shiftKey &&
                    document.activeElement === last
                  ) {
                    event.preventDefault();
                    first?.focus();
                  }
                }
              }}
            >
              <div
                className="drawer-overlay"
                aria-hidden="true"
                onClick={close}
              />
              <nav
                className="bg-base-100 min-h-full w-80 max-w-[85vw] p-4"
                aria-label="Main"
              >
                <div className="mb-4 flex items-center justify-between gap-2">
                  <span className="text-lg font-bold">Find My Mines</span>
                  <button
                    type="button"
                    className="btn btn-square btn-ghost"
                    aria-label="Close navigation"
                    onClick={close}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                      className="h-6 w-6 stroke-current"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth="2"
                        d="m6 6 12 12M6 18 18 6"
                      />
                    </svg>
                  </button>
                </div>
                <ul className="menu w-full p-0">
                  {[
                    { href: "/", label: "Home" },
                    { href: "/game", label: "Play" },
                    { href: "/game/leaderboard", label: "Leaderboard" },
                    { href: "/friends", label: "Friends" },
                    { href: "/game/achievements", label: "Achievements" },
                    { href: "/game/history", label: "History & replays" },
                    ...(isOperator(session?.user)
                      ? [{ href: "/operator", label: "Operator" }]
                      : []),
                  ].map(({ href, label }) => (
                    <li key={href}>
                      <Link
                        href={href}
                        aria-current={pathname === href ? "page" : undefined}
                        className={
                          pathname === href ? "menu-active" : undefined
                        }
                        onClick={close}
                      >
                        {label}
                      </Link>
                    </li>
                  ))}
                </ul>
                <div className="border-base-300 mt-4 space-y-3 border-t pt-4">
                  {isPending ? (
                    <p role="status">Checking your account…</p>
                  ) : sessionError ? (
                    <div role="alert" className="space-y-2">
                      <p className="text-error">
                        Unable to check your account.
                      </p>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => void refetch()}
                      >
                        Retry
                      </button>
                    </div>
                  ) : session ? (
                    <>
                      <p className="break-words">
                        Signed in as <strong>{session.user.name}</strong>
                      </p>
                      <button
                        type="button"
                        className="btn w-full"
                        disabled={loggingOut}
                        onClick={() => void logout()}
                      >
                        {loggingOut && (
                          <span
                            className="loading loading-spinner loading-sm"
                            aria-hidden="true"
                          />
                        )}
                        {loggingOut ? "Logging out…" : "Logout"}
                      </button>
                      {logoutError && (
                        <p role="alert" className="text-error">
                          {logoutError}
                        </p>
                      )}
                    </>
                  ) : (
                    <p>Playing as a guest</p>
                  )}
                </div>
              </nav>
            </div>
          </div>
        </TRPCReactProvider>
      </body>
    </html>
  );
}

function SocialConnection() {
  const router = useRouter();
  const pathname = usePathname();
  const utils = api.useUtils();
  const [error, setError] = useState("");
  const latest = useRef<{ instanceId: string; revision: number } | null>(null);
  const handled = useRef(new Set<string>());
  const invitations = api.game.invitations.useQuery(undefined, {
    retry: false,
  });
  const stream = api.friends.onUpdate.useSubscription(undefined, {
    onData(data) {
      if (
        latest.current?.instanceId === data.instanceId &&
        data.revision < latest.current.revision
      )
        return;
      latest.current = data;
      setError("");
      void utils.friends.invalidate();
      void utils.game.invitations.invalidate();
    },
    onError(cause) {
      setError(cause.message);
    },
  });
  const reset = stream.reset;
  useEffect(() => {
    if (stream.status !== "idle" || error) return;
    const timer = setTimeout(reset, 1000);
    return () => clearTimeout(timer);
  }, [stream.status, reset, error]);
  useEffect(() => {
    if (stream.status !== "pending") return;
    let cancelled = false;
    const beat = () => {
      void utils.client.friends.heartbeat.mutate().catch((cause: unknown) => {
        if (!cancelled) {
          setError(
            cause instanceof Error ? cause.message : "Social connection lost.",
          );
          reset();
        }
      });
    };
    beat();
    const timer = setInterval(beat, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [stream.status, utils.client, reset]);
  useEffect(() => {
    const reconnect = () => {
      setError("");
      reset();
    };
    window.addEventListener("online", reconnect);
    return () => window.removeEventListener("online", reconnect);
  }, [reset]);
  useEffect(() => {
    const accepted = invitations.data?.find((i) => i.roomId);
    if (!accepted?.roomId || handled.current.has(accepted.id)) return;
    handled.current.add(accepted.id);
    if (pathname !== `/game/${accepted.roomId}`)
      router.push(`/game/${accepted.roomId}`);
  }, [invitations.data, pathname, router]);
  const respond = api.game.respondInvitation.useMutation({
    retry: false,
    onSuccess() {
      void utils.game.invitations.invalidate();
    },
  });
  const pending = invitations.data?.find((i) => !i.roomId);
  const failure =
    error || (invitations.error?.message ?? respond.error?.message);
  if (!pending && !failure) return null;
  return (
    <aside
      aria-label="Friends and invitations"
      className="bg-base-100 border-base-300 flex flex-wrap items-center gap-3 border-b px-4 py-2 text-sm"
    >
      {pending && (
        <div role="status" className="flex flex-wrap items-center gap-2">
          <span>
            {pending.incoming
              ? `${pending.other.name} invited you to play.`
              : `Waiting for ${pending.other.name} to accept…`}
          </span>
          <span>
            This game affects Elo. Account names and ratings are public.
          </span>
          {pending.incoming && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={respond.isPending}
              onClick={() =>
                respond.mutate({ id: pending.id, action: "accept" })
              }
            >
              Accept and play
            </button>
          )}
          <button
            type="button"
            className="btn btn-sm"
            disabled={respond.isPending}
            onClick={() =>
              respond.mutate({
                id: pending.id,
                action: pending.incoming ? "decline" : "cancel",
              })
            }
          >
            {pending.incoming ? "Decline" : "Cancel"}
          </button>
        </div>
      )}
      {failure && (
        <div
          role="alert"
          className="text-error flex flex-wrap items-center gap-2"
        >
          <span>{failure}</span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setError("");
              reset();
              void utils.friends.invalidate();
              void utils.game.invitations.invalidate();
            }}
          >
            Retry
          </button>
        </div>
      )}
    </aside>
  );
}
