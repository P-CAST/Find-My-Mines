"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "~/trpc/react";
import { authClient } from "~/server/better-auth/client";
import { PageShell, Panel } from "~/app/_components/game/ui";
import type { RelationshipAction } from "~/server/friends/store";

export default function FriendsPage() {
  const { data: account, isPending } = authClient.useSession();
  return (
    <PageShell>
      <h1 className="mb-4 text-3xl font-bold">Friends</h1>
      {isPending ? (
        <p role="status">Checking your account…</p>
      ) : account ? (
        <FriendsContent key={account.user.id} />
      ) : (
        <Panel title="Play with friends">
          <p>
            Sign in to find players, add friends, and invite them to a game.
          </p>
          <Link href="/" className="btn btn-primary">
            Sign in
          </Link>
        </Panel>
      )}
    </PageShell>
  );
}

function FriendsContent() {
  const utils = api.useUtils();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"friends" | "incoming" | "outgoing">(
    "friends",
  );
  const [removing, setRemoving] = useState<{
    publicId: string;
    name: string;
  }>();
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text]);
  const list = api.friends.list.useInfiniteQuery(
    { kind },
    { getNextPageParam: (p) => p.nextCursor, retry: false },
  );
  const search = api.friends.search.useInfiniteQuery(
    { query },
    {
      enabled: query.length >= 2,
      getNextPageParam: (p) => p.nextCursor,
      retry: false,
    },
  );
  const change = api.friends.change.useMutation({
    retry: false,
    onSuccess() {
      setRemoving(undefined);
      void utils.friends.invalidate();
    },
  });
  const invite = api.game.inviteFriend.useMutation({
    retry: false,
    onSuccess() {
      void utils.game.invitations.invalidate();
    },
  });
  const action = (publicId: string, value: RelationshipAction) =>
    change.mutate({ publicId, action: value });
  const busy = change.isPending || invite.isPending;
  const failure = change.error?.message ?? invite.error?.message;
  return (
    <div className="space-y-5">
      <p className="mb-4 text-sm">
        Friend games affect Elo, including rematches and forfeits. Account names
        and ratings appear on the public leaderboard.
      </p>
      <Panel title="Find players">
        <label className="form-control">
          <span className="mb-1 block">Account name</span>
          <input
            className="input input-bordered w-full"
            value={text}
            maxLength={100}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search at least two characters"
          />
        </label>
        <p className="text-sm">
          Search finds account names. The ID suffix helps distinguish players
          with the same name.
        </p>
        {query.length >= 2 && (
          <>
            {search.isLoading && <p role="status">Searching…</p>}
            {search.error && (
              <div role="alert" className="text-error">
                {search.error.message}{" "}
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => void search.refetch()}
                >
                  Retry
                </button>
              </div>
            )}
            {search.data?.pages[0]?.items.length === 0 && (
              <p>No players found.</p>
            )}
            <ul className="divide-base-300 divide-y">
              {search.data?.pages
                .flatMap((p) => p.items)
                .map((person) => (
                  <li
                    key={person.publicId}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <span className="break-all">
                      {person.name}{" "}
                      <span className="text-sm">
                        #{person.publicId.slice(0, 8)}
                      </span>
                    </span>
                    {person.relationship === "none" ? (
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() => action(person.publicId, "send")}
                      >
                        Add friend
                      </button>
                    ) : (
                      <span>
                        {person.relationship === "friends"
                          ? "Friends"
                          : person.relationship === "incoming"
                            ? "Incoming request"
                            : "Request sent"}
                      </span>
                    )}
                  </li>
                ))}
            </ul>
            {search.hasNextPage && (
              <button
                type="button"
                className="btn"
                disabled={search.isFetchingNextPage}
                onClick={() => void search.fetchNextPage()}
              >
                More players
              </button>
            )}
          </>
        )}
      </Panel>
      {failure && (
        <p role="alert" className="alert alert-error">
          {failure}
        </p>
      )}
      <Panel title="Your connections">
        <div
          className="flex flex-wrap gap-2"
          role="group"
          aria-label="Connection list"
        >
          {(["friends", "incoming", "outgoing"] as const).map((value) => (
            <button
              type="button"
              key={value}
              className={`btn btn-sm ${kind === value ? "btn-active" : ""}`}
              aria-pressed={kind === value}
              onClick={() => setKind(value)}
            >
              {
                {
                  friends: "Friends",
                  incoming: "Incoming requests",
                  outgoing: "Sent requests",
                }[value]
              }
            </button>
          ))}
        </div>
        {list.isLoading && <p role="status">Loading…</p>}
        {list.error && (
          <div role="alert" className="text-error">
            {list.error.message}{" "}
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void list.refetch()}
            >
              Retry
            </button>
          </div>
        )}
        {list.data?.pages[0]?.items.length === 0 && (
          <p>
            {kind === "friends"
              ? "No friends yet. Search for a player to send a request."
              : "No requests."}
          </p>
        )}
        <ul className="divide-base-300 divide-y">
          {list.data?.pages
            .flatMap((p) => p.items)
            .map((person) => (
              <li
                key={person.publicId}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0 break-words">
                  <span>{person.name}</span>{" "}
                  <span className="text-sm">
                    #{person.publicId.slice(0, 8)}
                  </span>
                  {kind === "friends" && (
                    <p className="text-sm">
                      {person.online ? "● Online" : "○ Offline"}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {kind === "friends" ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={busy || !person.online}
                        onClick={() =>
                          invite.mutate({ publicId: person.publicId })
                        }
                      >
                        Invite to game
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() => setRemoving(person)}
                      >
                        Remove
                      </button>
                    </>
                  ) : kind === "incoming" ? (
                    <>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={busy}
                        onClick={() => action(person.publicId, "accept")}
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={busy}
                        onClick={() => action(person.publicId, "decline")}
                      >
                        Decline
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() => action(person.publicId, "cancel")}
                    >
                      Cancel request
                    </button>
                  )}
                </div>
              </li>
            ))}
        </ul>
        {list.hasNextPage && (
          <button
            type="button"
            className="btn"
            disabled={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            More connections
          </button>
        )}
        {removing && (
          <div className="alert flex flex-wrap gap-3" role="alert">
            <p>Remove {removing.name} from your friends?</p>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => action(removing.publicId, "remove")}
            >
              Remove friend
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setRemoving(undefined)}
            >
              Cancel
            </button>
          </div>
        )}
      </Panel>
    </div>
  );
}
