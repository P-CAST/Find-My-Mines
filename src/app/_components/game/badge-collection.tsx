import {
  ACHIEVEMENT_GROUPS,
  type AchievementDefinition,
} from "~/lib/achievements";

type Badge = AchievementDefinition & { progress?: number; unlockedAt?: Date };
export function BadgeCollection({ badges }: { badges: readonly Badge[] }) {
  return (
    <div className="space-y-6">
      {ACHIEVEMENT_GROUPS.map((group) => {
        const items = badges.filter((badge) => badge.mode === group.mode);
        if (!items.length) return null;
        return (
          <section key={group.mode} aria-label={group.label}>
            <h3 className="mb-3 text-lg font-semibold">{group.label}</h3>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {items.map((badge) => (
                <li
                  key={badge.id}
                  className="card border-base-300 bg-base-100 border"
                >
                  <div className="card-body gap-2 p-4">
                    <span
                      className={`badge ${badge.unlockedAt ? "badge-success" : "badge-outline"}`}
                    >
                      {badge.unlockedAt ? "✓ Earned" : "◇ Locked"}
                    </span>
                    <h4 className="font-bold">{badge.name}</h4>
                    <p className="text-sm">{badge.description}</p>
                    {badge.unlockedAt ? (
                      <p className="text-sm">
                        Earned {badge.unlockedAt.toLocaleDateString()}
                      </p>
                    ) : (
                      badge.progress !== undefined && (
                        <>
                          <progress
                            className="progress progress-primary"
                            value={badge.progress}
                            max={badge.target}
                            aria-label={`${badge.name} progress`}
                          />
                          <span className="text-sm">
                            {badge.progress} / {badge.target}
                          </span>
                        </>
                      )
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
