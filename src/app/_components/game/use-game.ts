"use client";
import { useEffect, useState } from "react";
import { api } from "~/trpc/react";
import type { GameSnapshot } from "~/server/game/service";
import type { Connection } from "./ui";

export function useGame() {
  const session = api.game.session.useQuery(undefined, {
    staleTime: Infinity,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const [state, setState] = useState<GameSnapshot>();
  const [connection, setConnection] = useState<Connection>("reconnecting");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  const utils = api.useUtils();
  const subscription = api.game.onState.useSubscription(undefined, {
    enabled: !!session.data,
    onData(snapshot) {
      if (session.data?.instanceId !== snapshot.instanceId)
        void session.refetch();
      setState((previous) =>
        previous?.instanceId !== snapshot.instanceId ||
        snapshot.revision >= previous.revision
          ? snapshot
          : previous,
      );
      setOffset(snapshot.serverNow - Date.now());
      setConnection("connected");
    },
    onError(cause) {
      setConnection("disconnected");
      setError(cause.message);
    },
  });
  const resetSubscription = subscription.reset;
  useEffect(() => {
    if (subscription.status === "connecting") setConnection("reconnecting");
    if (subscription.status === "error" || subscription.status === "idle")
      setConnection("disconnected");
  }, [subscription.status]);
  useEffect(() => {
    if (subscription.status !== "idle" || !session.data) return;
    const timer = setTimeout(resetSubscription, 1000);
    return () => clearTimeout(timer);
  }, [subscription.status, session.data, resetSubscription]);
  useEffect(() => {
    if (connection !== "connected") return;
    let cancelled = false;
    const beat = async () => {
      const before = Date.now();
      try {
        const timing = await utils.client.game.heartbeat.mutate();
        if (!cancelled) setOffset(timing.serverNow - (before + Date.now()) / 2);
      } catch {
        if (!cancelled) {
          setConnection("reconnecting");
          resetSubscription();
        }
      }
    };
    void beat();
    const timer = setInterval(() => {
      void beat();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [connection, utils.client, resetSubscription]);
  useEffect(() => {
    const offline = () => setConnection("disconnected");
    const online = () => {
      setConnection("reconnecting");
      resetSubscription();
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [resetSubscription]);
  return {
    session,
    state,
    connection,
    offset,
    error,
    setError,
    retry: () => {
      void session.refetch();
      resetSubscription();
    },
  };
}
