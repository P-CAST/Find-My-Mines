"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "~/trpc/react";
import { ConnectionStatus, PageShell, Panel } from "~/app/_components/game/ui";
import { useGameConnection } from "~/app/_components/game/use-game-connection";
import { GlobalMessageBoard } from "~/app/_components/game/global-message-board";

export default function GameLobby() {
  const {
    lobby,
    account,
    connection,
    error,
    setError,
    retry,
    nickname,
    setNickname,
  } = useGameConnection();
  const router = useRouter();
  const [visibility, setVisibility] = useState<"public" | "unlisted">("public");
  const waiting = useRef(false);
  const onError = (cause: { message: string }) => setError(cause.message);
  const create = api.game.create.useMutation({
    onError,
    onSuccess: (result) => router.push(`/game/${result.roomId}`),
  });
  const bot = api.game.createBot.useMutation({
    onError,
    onSuccess: (result) => router.push(`/game/${result.roomId}`),
  });
  const queue = api.game.queueJoin.useMutation({
    onError,
    onSuccess: (result) => {
      waiting.current = true;
      if (result.roomId) router.push(`/game/${result.roomId}`);
    },
  });
  const cancel = api.game.queueCancel.useMutation({
    onError,
    onSuccess: () => {
      waiting.current = false;
    },
  });
  useEffect(() => {
    if (lobby?.queuedAt != null) waiting.current = true;
    if (waiting.current && lobby?.roomId) {
      waiting.current = false;
      router.push(`/game/${lobby.roomId}`);
    }
  }, [lobby, router]);
  const queued = lobby?.queuedAt != null;
  const busy =
    connection !== "connected" ||
    create.isPending ||
    bot.isPending ||
    queue.isPending ||
    cancel.isPending ||
    !nickname.trim();
  return (
    <PageShell>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold">Game lobby</h1>
        <ConnectionStatus status={connection} />
      </div>
      {error && (
        <div className="alert alert-error mb-4" role="alert">
          <span>{error}</span>
          <button className="btn btn-sm" onClick={retry}>
            Retry connection
          </button>
        </div>
      )}
      <div className="grid items-stretch gap-5 md:grid-cols-2">
        <Panel title="Play a game">
          <p>Find an opponent, practice with a bot, or challenge a friend.</p>
          <p className="text-sm">
            All two-account games affect Elo, including rematches and forfeits.
            Your account name and rating appear on the public leaderboard. Bot
            and guest games are unrated.
          </p>
          {lobby?.roomId ? (
            <>
              <p>You already have a seat in a room.</p>
              <Link className="btn btn-primary" href={`/game/${lobby.roomId}`}>
                Resume game
              </Link>
            </>
          ) : (
            <>
              <label className="fieldset">
                <span className="fieldset-legend">Your nickname</span>
                <input
                  className="input w-full"
                  maxLength={24}
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  disabled={queued}
                  autoComplete="nickname"
                />
              </label>
              {queued ? (
                <div role="status" className="space-y-3">
                  <p>
                    <span className="loading loading-spinner loading-sm mr-2" />
                    Finding an opponent…
                  </p>
                  <p className="text-sm">
                    {account
                      ? "Account opponents are preferred for 30 seconds. After that, you may be paired with a guest."
                      : "Guest games are temporary and have no saved history or replay."}
                  </p>
                  <button
                    className="btn"
                    onClick={() => cancel.mutate()}
                    disabled={cancel.isPending}
                  >
                    Cancel matchmaking
                  </button>
                </div>
              ) : (
                <>
                  <button
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => queue.mutate({ nickname })}
                  >
                    Find opponent
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={
                      busy || !lobby?.bot.available || !lobby.bot.remaining
                    }
                    onClick={() => bot.mutate({ nickname })}
                  >
                    {bot.isPending ? "Creating bot game…" : "Play with bot"}
                  </button>
                  <p className="text-sm" role="status">
                    {!lobby
                      ? "Connecting to bot availability…"
                      : !lobby.bot.available
                        ? "Bot play is not configured."
                        : lobby.bot.remaining
                          ? `Bot practice · ${lobby.bot.remaining}/3 games available this hour, shared by everyone. No result or replay is saved.`
                          : `All 3 shared bot games have been used. Next available at ${new Date(lobby.bot.nextAvailableAt!).toLocaleTimeString()}.`}
                  </p>
                  <label className="fieldset">
                    <span className="fieldset-legend">Room visibility</span>
                    <select
                      className="select w-full"
                      value={visibility}
                      onChange={(e) =>
                        setVisibility(e.target.value as "public" | "unlisted")
                      }
                    >
                      <option value="public">
                        Public — listed in the lobby
                      </option>
                      <option value="unlisted">
                        Invite-only — share a link
                      </option>
                    </select>
                  </label>
                  <button
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={() => create.mutate({ nickname, visibility })}
                  >
                    Create room
                  </button>
                </>
              )}
            </>
          )}
          <p className="text-sm">
            Games between two accounts save a result and replay. Any game with a
            guest is unrecorded.
          </p>
          {account ? (
            <Link href="/game/history" className="link">
              My history, replays and privacy
            </Link>
          ) : (
            <Link href="/" className="link">
              Sign in to save account games
            </Link>
          )}
        </Panel>
        <GlobalMessageBoard />
        <div className="min-w-0 md:col-span-2">
          <Panel title="Public rooms">
            {!lobby ? (
              <p role="status">Connecting to the lobby…</p>
            ) : !lobby.rooms.length ? (
              <p>No public rooms yet. Create one or find an opponent.</p>
            ) : (
              <ul className="space-y-3">
                {lobby.rooms.map((room) => (
                  <li
                    key={room.roomId}
                    className="border-base-300 rounded-box space-y-2 border p-3"
                  >
                    <div className="flex flex-wrap justify-between gap-2">
                      <strong>
                        {room.players.map((p) => p.nickname).join(" vs ") ||
                          "Open room"}
                      </strong>
                      <span className="badge badge-outline">{room.phase}</span>
                    </div>
                    <p className="text-sm">
                      {room.players.length}/2 seats ·{" "}
                      {room.players.some((p) => !p.account)
                        ? "Guest game · unrecorded"
                        : "Account players"}
                    </p>
                    <Link
                      className={`btn btn-sm ${room.phase === "lobby" && room.players.length < 2 ? "btn-primary" : ""}`}
                      href={`/game/${room.roomId}`}
                    >
                      {room.phase === "lobby" && room.players.length < 2
                        ? "Join room"
                        : "Watch"}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </PageShell>
  );
}
