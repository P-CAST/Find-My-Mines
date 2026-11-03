"use client";
import Link from "next/link";
import { ACHIEVEMENTS } from "~/lib/achievements";
import { api } from "~/trpc/react";
import { authClient } from "~/server/better-auth/client";
import { BadgeCollection } from "~/app/_components/game/badge-collection";
import { PageShell, Panel } from "~/app/_components/game/ui";

export default function AchievementsPage() {
  const {
    data: account,
    isPending,
    error: sessionError,
  } = authClient.useSession();
  const utils = api.useUtils();
  const collection = api.game.achievements.useQuery(undefined, {
    enabled: !!account,
    retry: false,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
  });
  const visibility = api.game.setAchievementVisibility.useMutation({
    onSuccess: () => {
      void utils.game.achievements.invalidate();
      void utils.game.publicAchievements.invalidate();
    },
  });
  const data = collection.data;
  const badges =
    data?.catalogue.map((badge) => ({
      ...badge,
      unlockedAt: data.badges.find((earned) => earned.id === badge.id)
        ?.unlockedAt,
    })) ?? ACHIEVEMENTS;
  return (
    <PageShell>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-3xl font-bold">Achievements</h1>
        <Link className="btn btn-sm" href="/game">
          Game lobby
        </Link>
      </div>
      <div className="space-y-5">
        <Panel title="Your badge collection">
          <p>
            Earn 15 permanent badges in bot and human games. Only new, normally
            completed games count. Human games require two signed-in accounts.
            Forfeits and games with guests do not count.
          </p>
          <p>
            Badges and progress appear after the game has been saved. Finding
            mines keeps your turn; an empty cell or timeout ends it.
          </p>
          {isPending ? (
            <p role="status">Checking your account…</p>
          ) : sessionError ? (
            <p role="alert" className="text-error">
              Unable to check your account. Refresh to try again.
            </p>
          ) : !account ? (
            <>
              <p>Sign in before starting a game to earn badges.</p>
              <Link className="btn btn-primary" href="/">
                Sign in
              </Link>
            </>
          ) : collection.isPending ? (
            <p role="status">Loading badges…</p>
          ) : collection.error ? (
            <div role="alert">
              <p className="text-error">{collection.error.message}</p>
              <button
                className="btn btn-sm"
                onClick={() => void collection.refetch()}
              >
                Retry
              </button>
            </div>
          ) : (
            data && (
              <>
                <p>
                  {data.badges.length} / {ACHIEVEMENTS.length} badges earned
                </p>
                <label className="label justify-start gap-3">
                  <input
                    type="checkbox"
                    className="toggle toggle-primary"
                    checked={data.achievementsPublic}
                    disabled={visibility.isPending}
                    onChange={(event) =>
                      visibility.mutate({
                        achievementsPublic: event.target.checked,
                      })
                    }
                  />
                  <span>Allow public badge collection</span>
                </label>
                <p className="text-sm">
                  Sharing badges does not share your history, opponents, or
                  replays.
                </p>
                {data.achievementsPublic && (
                  <Link className="link" href={`/players/${data.publicId}`}>
                    Open my public collection
                  </Link>
                )}
                {visibility.error && (
                  <p role="alert" className="text-error">
                    {visibility.error.message}
                  </p>
                )}
              </>
            )
          )}
        </Panel>
        {(!account || data) && !isPending && !sessionError && (
          <Panel title="Badges">
            <BadgeCollection badges={badges} />
          </Panel>
        )}
      </div>
    </PageShell>
  );
}
