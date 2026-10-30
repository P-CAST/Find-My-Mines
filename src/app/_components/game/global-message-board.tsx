"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "~/trpc/react";
import { authClient } from "~/server/better-auth/client";
import type { BoardSnapshot } from "~/server/messages/service";
import { Panel } from "./ui";

export function GlobalMessageBoard() {
  const { data: account, isPending } = authClient.useSession();
  // Shares the page's HTTP bootstrap query, never a game presence connection.
  const session = api.game.session.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  return (
    <MessageBoard
      key={`${account?.user.id ?? "guest"}:${session.data?.id ?? ""}`}
      ready={!!session.data && !isPending && !session.isFetching}
      bootstrapError={session.error?.message}
      refreshSession={session.refetch}
    />
  );
}

function MessageBoard({
  ready,
  bootstrapError,
  refreshSession,
}: {
  ready: boolean;
  bootstrapError?: string;
  refreshSession: () => Promise<unknown>;
}) {
  const [board, setBoard] = useState<BoardSnapshot>();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [online, setOnline] = useState(true);
  const [unread, setUnread] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const instance = useRef<string | undefined>(undefined);
  const stream = api.messages.onBoard.useSubscription(undefined, {
    enabled: ready,
    onData(data) {
      if (instance.current && instance.current !== data.instanceId)
        void refreshSession();
      instance.current = data.instanceId;
      setBoard((previous) =>
        previous?.instanceId !== data.instanceId ||
        data.revision > previous.revision
          ? data
          : previous,
      );
      setError("");
    },
    onError(cause) {
      setError(cause.message);
    },
  });
  const reset = stream.reset;
  useEffect(() => {
    if (!ready || stream.status !== "idle") return;
    const timer = setTimeout(reset, 1000);
    return () => clearTimeout(timer);
  }, [ready, stream.status, reset]);
  useEffect(() => {
    const offline = () => setOnline(false);
    const reconnect = () => {
      setOnline(true);
      reset();
    };
    setOnline(navigator.onLine);
    window.addEventListener("offline", offline);
    window.addEventListener("online", reconnect);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", reconnect);
    };
  }, [reset]);
  useEffect(() => {
    if (!board || !log.current) return;
    if (nearBottom.current) log.current.scrollTop = log.current.scrollHeight;
    else setUnread(true);
  }, [board]);
  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown(false), 2000);
    return () => clearTimeout(timer);
  }, [cooldown]);
  const send = api.messages.send.useMutation({
    retry: false,
    onSuccess() {
      setText("");
      setCooldown(true);
    },
  });
  const validation = send.error?.data?.zodError;
  const sendError =
    validation?.fieldErrors.text?.[0] ??
    validation?.formErrors[0] ??
    send.error?.message;
  const connected = ready && online && stream.status === "pending";
  const canSend = connected && !!text.trim() && !send.isPending && !cooldown;
  return (
    <Panel
      title="Global message board"
      bodyClassName="gap-0 p-0"
      titleClassName="justify-start px-4 py-4 text-left"
    >
      <div className="divider m-0" />
      {(error || bootstrapError) && (
        <div className="px-3 pt-3">
          <div className="alert alert-warning" role="alert">
            <span>{error || bootstrapError}</span>
          </div>
        </div>
      )}
      {!connected && (
        <button
          className="btn btn-sm mx-3 mt-3 self-center"
          type="button"
          onClick={() => {
            setError("");
            void refreshSession().then(() => reset());
          }}
        >
          Retry messaging connection
        </button>
      )}
      <div
        ref={log}
        role="log"
        aria-label="Global messages"
        aria-live="polite"
        aria-relevant="additions text"
        tabIndex={0}
        className="focus-visible:outline-primary h-80 min-h-0 min-w-0 grow overflow-y-auto px-4 py-2 focus-visible:outline-2 focus-visible:-outline-offset-2"
        onScroll={() => {
          const element = log.current;
          if (!element) return;
          nearBottom.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            48;
          if (nearBottom.current) setUnread(false);
        }}
      >
        {!board ? (
          <p role="status" className="text-sm">
            Connecting to messages…
          </p>
        ) : !board.messages.length ? (
          <p className="text-sm">No messages yet. Say hello!</p>
        ) : (
          board.messages.map((message) => (
            <div
              className={`chat ${message.own ? "chat-end" : "chat-start"}`}
              key={message.id}
            >
              <div className="chat-header flex-wrap [overflow-wrap:anywhere] break-words">
                <span>
                  {message.nickname}
                  {message.own ? " (you)" : ""}
                </span>
                <span className="badge badge-outline badge-xs">
                  {message.account ? "Account" : "Guest"}
                </span>
                <time dateTime={new Date(message.sentAt).toISOString()}>
                  {new Date(message.sentAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              <div
                className={`chat-bubble [overflow-wrap:anywhere] whitespace-pre-wrap ${message.own ? "chat-bubble-primary" : ""}`}
              >
                {message.text}
              </div>
            </div>
          ))
        )}
      </div>
      {unread && (
        <button
          className="btn btn-sm mx-3 mb-2 self-center"
          type="button"
          onClick={() => {
            if (log.current) log.current.scrollTop = log.current.scrollHeight;
            nearBottom.current = true;
            setUnread(false);
          }}
        >
          New messages ↓
        </button>
      )}
      <div className="divider m-0" />
      <form
        className="p-3 sm:p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) send.mutate({ text });
        }}
      >
        <fieldset className="min-w-0" disabled={send.isPending}>
          <div className="flex min-w-0 items-center gap-2">
            <input
              className="input min-w-0 flex-1"
              aria-label="Your message"
              placeholder="Write a message…"
              maxLength={500}
              value={text}
              onChange={(event) => setText(event.target.value)}
              required
              onKeyDown={(event) => {
                if (event.key === "Enter" && event.nativeEvent.isComposing) {
                  event.preventDefault();
                }
              }}
            />
            <button
              className="btn btn-primary shrink-0"
              type="submit"
              disabled={!canSend}
            >
              {send.isPending ? "Sending…" : "Send"}
            </button>
          </div>
          {sendError && (
            <p className="text-error mt-2 text-sm" role="alert">
              {sendError}
            </p>
          )}
        </fieldset>
      </form>
    </Panel>
  );
}
