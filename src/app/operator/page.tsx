"use client";
import { useRef, useState } from "react";
import { api } from "~/trpc/react";
import type { ClientsSnapshot, GameSnapshot } from "~/server/game/service";
import {
  ConnectionStatus,
  PageShell,
  Panel,
  PlayerScore,
} from "~/app/_components/game/ui";

export default function OperatorPage() {
  const session = api.game.session.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [data, setData] = useState<ClientsSnapshot>();
  const [selected, setSelected] = useState("");
  const [room, setRoom] = useState<GameSnapshot>();
  const [resetTarget, setResetTarget] = useState<string>();
  const modal = useRef<HTMLDialogElement>(null);
  const onError = (cause: { message: string }) => setError(cause.message);
  const login = api.game.login.useMutation({
    onError,
    onSuccess: () => {
      setPassword("");
      setError("");
      void session.refetch();
    },
  });
  const logout = api.game.logout.useMutation({
    onError,
    onSuccess: () => {
      setData(undefined);
      setRoom(undefined);
      setSelected("");
      void session.refetch();
    },
  });
  const reset = api.game.reset.useMutation({
    onError,
    onSuccess: () => {
      setError("");
      modal.current?.close();
    },
  });
  const start = api.game.start.useMutation({
    onError,
    onSuccess: () => setError(""),
  });
  const stream = api.game.onClients.useSubscription(undefined, {
    enabled: session.data?.operator === true,
    onData(snapshot) {
      setData((previous) =>
        previous?.instanceId !== snapshot.instanceId ||
        snapshot.revision >= previous.revision
          ? snapshot
          : previous,
      );
    },
    onError,
  });
  const selectedExists = !!data?.rooms.some((r) => r.roomId === selected);
  api.game.onRoom.useSubscription(
    { roomId: selected || "00000000-0000-0000-0000-000000000000" },
    {
      enabled: session.data?.operator === true && selectedExists,
      onData(snapshot) {
        setRoom((previous) =>
          previous?.roomId !== snapshot.roomId ||
          previous.instanceId !== snapshot.instanceId ||
          snapshot.revision >= previous.revision
            ? snapshot
            : previous,
        );
      },
      onError,
    },
  );
  const current =
    selectedExists && room?.roomId === selected ? room : undefined;
  const connected = stream.status === "pending";
  return (
    <PageShell>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold">Operator dashboard</h1>
        {session.data?.operator && (
          <>
            <ConnectionStatus
              status={
                connected
                  ? "connected"
                  : stream.status === "connecting"
                    ? "reconnecting"
                    : "disconnected"
              }
            />
            <button
              className="btn btn-sm"
              disabled={logout.isPending}
              onClick={() => logout.mutate()}
            >
              Log out
            </button>
          </>
        )}
      </div>
      {(error || session.error) && (
        <div className="alert alert-error mb-4" role="alert">
          <span>{error || session.error?.message}</span>
          <button
            className="btn btn-sm"
            onClick={() => {
              setError("");
              void session.refetch();
              stream.reset();
            }}
          >
            Retry
          </button>
        </div>
      )}
      {session.isPending ? (
        <span className="loading loading-spinner" />
      ) : !session.data?.operator ? (
        <Panel title="Operator login">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              login.mutate({ password });
            }}
          >
            <fieldset className="fieldset">
              <legend className="fieldset-legend">Operator password</legend>
              <input
                type="password"
                className="input w-full"
                aria-label="Operator password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
              <button
                className="btn btn-primary mt-2"
                disabled={login.isPending || !password}
              >
                Log in
              </button>
            </fieldset>
          </form>
        </Panel>
      ) : !data ? (
        <Panel title="Loading dashboard">
          <span className="loading loading-spinner" />
        </Panel>
      ) : (
        <div className="space-y-5">
          <Panel title="Rooms and matchmaking">
            <p>
              {data.rooms.length} rooms · {data.queued} queued players ·{" "}
              {data.count} connected sessions
            </p>
            <p>
              {data.pendingSaves} pending result/achievement saves ·{" "}
              {data.failedSaves} failed saves retrying
            </p>
            <label className="fieldset">
              <span className="fieldset-legend">Select room</span>
              <select
                className="select w-full"
                value={selectedExists ? selected : ""}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setRoom(undefined);
                }}
              >
                <option value="">Choose a room</option>
                {data.rooms.map((r) => (
                  <option value={r.roomId} key={r.roomId}>
                    {r.players.map((p) => p.nickname).join(" vs ")} · {r.phase}{" "}
                    · {r.roomId.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>
          </Panel>
          {current && (
            <Panel title="Selected room controls">
              <p role="status">{current.message}</p>
              <p className="text-sm break-all">
                Room {current.roomId} · {current.visibility}
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {current.players.map((p) => (
                  <PlayerScore
                    key={p.id}
                    player={p}
                    active={p.id === current.activePlayer}
                    own={false}
                  />
                ))}
              </div>
              <div className="flex flex-wrap gap-3">
                <button
                  className="btn btn-error"
                  disabled={!connected || reset.isPending}
                  onClick={() => {
                    setResetTarget(current.roomId);
                    modal.current?.showModal();
                  }}
                >
                  Reset game
                </button>
                <button
                  className="btn btn-primary"
                  disabled={
                    !connected ||
                    start.isPending ||
                    current.phase !== "lobby" ||
                    !current.manualStart ||
                    current.players.length !== 2 ||
                    current.players.some((p) => !p.connected)
                  }
                  onClick={() => start.mutate({ roomId: current.roomId })}
                >
                  Start game
                </button>
              </div>
              <p className="text-sm">
                Reset cancels this match without a result, keeps connected
                seats, and waits for Start. Previously saved results remain in
                history.
              </p>
            </Panel>
          )}
          <Panel title="Connected game clients">
            <p className="text-sm">
              Multiple tabs share one session. Account devices can share a seat.
              Operator streams are excluded.
            </p>
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Nickname</th>
                    <th>Public session ID</th>
                    <th>Room</th>
                  </tr>
                </thead>
                <tbody>
                  {data.clients.map((c) => (
                    <tr key={c.id}>
                      <td>{c.nickname}</td>
                      <td className="font-mono text-xs">{c.id}</td>
                      <td>{c.roomId?.slice(0, 8) ?? "Lobby"}</td>
                    </tr>
                  ))}
                  {!data.count && (
                    <tr>
                      <td colSpan={3}>No game clients connected.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      )}
      <dialog ref={modal} className="modal" aria-labelledby="reset-title">
        <div className="modal-box">
          <h2 id="reset-title" className="text-lg font-bold">
            Reset this game?
          </h2>
          <p className="py-4 break-all">
            Room {resetTarget}. This clears its current board, scores, and
            votes. Connected players stay seated. No result is saved for a
            canceled match.
          </p>
          <div className="modal-action">
            <button className="btn" onClick={() => modal.current?.close()}>
              Cancel
            </button>
            <button
              className="btn btn-error"
              disabled={
                !connected ||
                reset.isPending ||
                !resetTarget ||
                !data?.rooms.some((r) => r.roomId === resetTarget)
              }
              onClick={() =>
                resetTarget && reset.mutate({ roomId: resetTarget })
              }
            >
              Reset game
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
