"use client";
import Link from "next/link";
import { api } from "~/trpc/react";
import { authClient } from "~/server/better-auth/client";
import { PageShell, Panel } from "./ui";

export function HistoryView({ publicId }: { publicId?: string }) {
  const { data: account, isPending } = authClient.useSession();
  const own = !publicId;
  const utils = api.useUtils();
  const profile = api.game.profile.useQuery(undefined, {
    enabled: own && !!account,
    retry: false,
  });
  const history = api.game.history.useInfiniteQuery(
    { publicId },
    {
      enabled: !isPending && (!!publicId || !!account),
      retry: false,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );
  const visibility = api.game.setVisibility.useMutation({
    onSuccess: (data) => {
      utils.game.profile.setData(undefined, data);
      void utils.game.history.invalidate();
      void utils.game.replay.invalidate();
      void utils.game.analysis.invalidate();
    },
  });
  return (
    <PageShell>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold">
          {own ? "My game history" : "Public game history"}
        </h1>
        <Link className="btn btn-sm" href="/game">
          Game lobby
        </Link>
      </div>
      {own && !account ? (
        <Panel title="Sign in to view your history">
          <p>
            Games with guests are temporary and have no saved result or replay.
          </p>
          <Link className="btn btn-primary" href="/">
            Sign in
          </Link>
        </Panel>
      ) : (
        <div className="space-y-5">
          {own && (
            <Panel title="History privacy">
              <p>
                History is private by default. A result and its replay are
                public only when both players choose public history. You can
                always view your own games.
              </p>
              {profile.data && (
                <>
                  <label className="label justify-start gap-3">
                    <input
                      type="checkbox"
                      className="toggle toggle-primary"
                      checked={profile.data.historyPublic}
                      disabled={visibility.isPending}
                      onChange={(e) =>
                        visibility.mutate({ historyPublic: e.target.checked })
                      }
                    />
                    <span>Allow public history and replays</span>
                  </label>
                  {profile.data.historyPublic && (
                    <Link
                      className="link"
                      href={`/players/${profile.data.publicId}`}
                    >
                      Open my public history link
                    </Link>
                  )}
                </>
              )}
              {(profile.error ?? visibility.error) && (
                <p role="alert" className="text-error">
                  {profile.error?.message ?? visibility.error?.message}
                </p>
              )}
            </Panel>
          )}
          <Panel title="Results and replays">
            {history.isPending ? (
              <p role="status">Loading history…</p>
            ) : history.error ? (
              <p role="alert" className="text-error">
                {history.error.message}
              </p>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Players</th>
                        <th>Score</th>
                        <th>Winner</th>
                        <th>Finished</th>
                        <th>Replay</th>
                      </tr>
                    </thead>
                    <tbody>
                      {history.data?.pages
                        .flatMap((page) => page.items)
                        .map((result) => (
                          <tr key={result.matchId}>
                            <td>
                              {result.playerOneName} vs {result.playerTwoName}
                            </td>
                            <td>
                              {result.playerOneScore}–{result.playerTwoScore}
                            </td>
                            <td>
                              {result.winnerSeat === 0
                                ? result.playerOneName
                                : result.playerTwoName}
                              {result.reason === "forfeit" ? " (forfeit)" : ""}
                            </td>
                            <td>{result.finishedAt.toLocaleString()}</td>
                            <td>
                              <Link
                                className="link"
                                href={`/game/replay/${result.matchId}`}
                              >
                                Watch replay
                              </Link>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
                {!history.data?.pages[0]?.items.length && (
                  <p>No saved games to display.</p>
                )}
                {history.hasNextPage && (
                  <button
                    className="btn"
                    disabled={history.isFetchingNextPage}
                    onClick={() => void history.fetchNextPage()}
                  >
                    Load more
                  </button>
                )}
              </>
            )}
          </Panel>
        </div>
      )}
    </PageShell>
  );
}
