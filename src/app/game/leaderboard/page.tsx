"use client";
import Link from "next/link";
import { useState } from "react";
import { PageShell, Panel } from "~/app/_components/game/ui";
import { authClient } from "~/server/better-auth/client";
import { api } from "~/trpc/react";

export default function LeaderboardPage() {
  const [page, setPage] = useState(0);
  const { data: session } = authClient.useSession();
  const leaderboard = api.game.leaderboard.useQuery(
    { page },
    {
      refetchOnMount: "always",
      refetchOnWindowFocus: "always",
    },
  );
  const own = api.game.rating.useQuery(undefined, {
    enabled: !!session,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
  });
  return (
    <PageShell>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold">Leaderboard</h1>
        <Link className="btn btn-sm" href="/game">
          Game lobby
        </Link>
      </div>
      <div className="space-y-5">
        <p>
          Two-account games, including friend games, rematches, and forfeits,
          affect Elo. Account names and ratings are public. Everyone starts at
          1000; bots and guest games are unrated. History and replay privacy
          still applies.
        </p>
        {session && (
          <Panel title="Your rating">
            {own.isPending ? (
              <p role="status">Loading rating…</p>
            ) : own.error ? (
              <p role="alert">
                Unable to load your rating. Use Refresh to retry.
              </p>
            ) : (
              own.data && (
                <p>
                  <strong>{own.data.rating} Elo</strong> ·{" "}
                  {own.data.rank === null
                    ? "Unranked — play a two-account game to join"
                    : `Rank #${own.data.rank}`}{" "}
                  · {own.data.games} games · {own.data.wins} wins ·{" "}
                  {own.data.losses} losses
                </p>
              )
            )}
          </Panel>
        )}
        <Panel title="Player rankings">
          <button
            className="btn btn-sm"
            disabled={leaderboard.isFetching || (!!session && own.isFetching)}
            onClick={() => {
              void leaderboard.refetch();
              if (session) void own.refetch();
            }}
          >
            Refresh
          </button>
          {leaderboard.isPending ? (
            <p role="status">Loading leaderboard…</p>
          ) : leaderboard.error ? (
            <p role="alert">Unable to load rankings. Use Refresh to retry.</p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="table">
                  <caption className="sr-only">
                    Players ranked by Elo. Equal ratings share a rank.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Rank</th>
                      <th scope="col">Player</th>
                      <th scope="col">Elo</th>
                      <th scope="col">Games</th>
                      <th scope="col">Wins</th>
                      <th scope="col">Losses</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leaderboard.data?.items.map((p) => (
                      <tr key={p.publicId}>
                        <td>{p.rank}</td>
                        <td>
                          <Link
                            className="link"
                            href={`/players/${p.publicId}`}
                          >
                            {p.name}
                          </Link>
                        </td>
                        <td>{p.rating}</td>
                        <td>{p.games}</td>
                        <td>{p.wins}</td>
                        <td>{p.losses}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!leaderboard.data?.items.length && (
                <p>No rated players on this page yet.</p>
              )}
              <div className="flex items-center gap-3">
                <button
                  className="btn"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </button>
                <span>Page {page + 1}</span>
                <button
                  className="btn"
                  disabled={!leaderboard.data?.hasNextPage}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </>
          )}
        </Panel>
      </div>
    </PageShell>
  );
}
