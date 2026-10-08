"use client";
import { useRef, useState } from "react";
import { api } from "~/trpc/react";
import type { ClientsSnapshot } from "~/server/game/service";
import { ConnectionStatus, PageShell, Panel, PlayerScore } from "./ui";

export function OperatorScreen() {
  const session = api.game.session.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [data, setData] = useState<ClientsSnapshot>();
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
        previous?.game.instanceId !== snapshot.game.instanceId ||
        snapshot.revision >= previous.revision
          ? snapshot
          : previous,
      );
    },
    onError,
  });
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
              onClick={() => logout.mutate()}
              disabled={logout.isPending}
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
          <p>Use the password configured on this server.</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              login.mutate({ password });
            }}
          >
            <fieldset className="fieldset">
              <legend className="fieldset-legend">Operator password</legend>
              <input
                type="password"
                aria-label="Operator password"
                autoComplete="current-password"
                className="input w-full"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
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
          <Panel title="Match controls">
            <div className="flex flex-wrap gap-2">
              <span className="badge badge-outline">{data.game.phase}</span>
              <span className="badge badge-outline">
                Revision {data.game.revision}
              </span>
            </div>
            <p role="status">{data.game.message}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {data.game.players.map((player) => (
                <PlayerScore
                  key={player.id}
                  player={player}
                  active={data.game.activePlayer === player.id}
                  own={false}
                />
              ))}
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                className="btn btn-error"
                disabled={!connected || reset.isPending}
                onClick={() => modal.current?.showModal()}
              >
                Reset game
              </button>
              <button
                className="btn btn-primary"
                disabled={
                  !connected ||
                  start.isPending ||
                  data.game.phase !== "lobby" ||
                  !data.game.manualStart ||
                  data.game.players.length !== 2 ||
                  data.game.players.some((p) => !p.connected)
                }
                onClick={() => start.mutate()}
              >
                Start game
              </button>
            </div>
            <p className="text-sm">
              Reset keeps connected player seats and waits for Start. Initial
              joins and agreed rematches start automatically.
            </p>
          </Panel>
          <Panel title="Connected game clients">
            <div className="stats">
              <div className="stat">
                <div className="stat-title">Unique sessions</div>
                <div className="stat-value">{data.count}</div>
              </div>
            </div>
            <p className="text-sm">
              Includes players and visitors. Multiple tabs count once. Operator
              streams are excluded.
            </p>
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Nickname</th>
                    <th>Public session ID</th>
                  </tr>
                </thead>
                <tbody>
                  {data.clients.map((client) => (
                    <tr key={client.id}>
                      <td>{client.nickname}</td>
                      <td className="font-mono text-xs">{client.id}</td>
                    </tr>
                  ))}
                  {!data.count && (
                    <tr>
                      <td colSpan={2}>No game clients connected.</td>
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
          <p className="py-4">
            This clears the board, scores, result, and rematch votes. Connected
            players stay seated in the lobby.
          </p>
          <div className="modal-action">
            <button className="btn" onClick={() => modal.current?.close()}>
              Cancel
            </button>
            <button
              className="btn btn-error"
              disabled={!connected || reset.isPending}
              onClick={() => reset.mutate()}
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
