"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "~/trpc/react";
import { authClient } from "~/server/better-auth/client";
import type { GameSnapshot, LobbySnapshot } from "~/server/game/service";
import type { Connection } from "./ui";

export function useGameConnection(roomId?: string) {
  const { data: account, isPending: accountPending } = authClient.useSession();
  const session = api.game.session.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });
  const refetchSession = session.refetch;
  const [room, setRoom] = useState<GameSnapshot>();
  const [lobby, setLobby] = useState<LobbySnapshot>();
  const [error, setError] = useState("");
  const [offset, setOffset] = useState(0);
  const [connection, setConnection] = useState<Connection>("reconnecting");
  const [editedName, setEditedName] = useState<string>();
  const utils = api.useUtils();
  const onError = (cause: { message: string }) => {
    setError(cause.message);
    setConnection("disconnected");
  };
  const timing = (data: { serverNow: number; instanceId: string }) => {
    setOffset(data.serverNow - Date.now());
    setConnection("connected");
    if (session.data?.instanceId !== data.instanceId) void refetchSession();
  };
  const roomStream = api.game.onState.useSubscription(
    { roomId: roomId ?? "00000000-0000-0000-0000-000000000000" },
    {
      enabled: !!roomId && !!session.data && !accountPending,
      onData(data) {
        timing(data);
        setRoom((previous) =>
          previous?.roomId !== data.roomId ||
          previous.instanceId !== data.instanceId ||
          data.revision >= previous.revision
            ? data
            : previous,
        );
      },
      onError,
    },
  );
  const lobbyStream = api.game.onLobby.useSubscription(undefined, {
    enabled: !roomId && !!session.data && !accountPending,
    onData(data) {
      timing(data);
      setLobby((previous) =>
        previous?.instanceId !== data.instanceId ||
        data.revision >= previous.revision
          ? data
          : previous,
      );
    },
    onError,
  });
  const resetRoom = roomStream.reset,
    resetLobby = lobbyStream.reset;
  const reset = useCallback(() => {
    if (roomId) resetRoom();
    else resetLobby();
  }, [roomId, resetRoom, resetLobby]);
  const streamStatus = roomId ? roomStream.status : lobbyStream.status;
  const identity = account?.user.id ?? null;
  const previousIdentity = useRef(identity);
  useEffect(() => {
    if (accountPending || previousIdentity.current === identity) return;
    previousIdentity.current = identity;
    setRoom(undefined);
    setLobby(undefined);
    void refetchSession();
    reset();
  }, [identity, accountPending, reset, refetchSession]);
  useEffect(() => {
    setRoom(undefined);
    setError("");
  }, [roomId]);
  useEffect(() => {
    setConnection(
      streamStatus === "pending"
        ? "connected"
        : streamStatus === "connecting"
          ? "reconnecting"
          : "disconnected",
    );
    if (streamStatus !== "idle" || !session.data || room?.phase === "closed")
      return;
    const timer = setTimeout(reset, 1000);
    return () => clearTimeout(timer);
  }, [streamStatus, session.data, reset, room?.phase]);
  useEffect(() => {
    if (streamStatus !== "pending" || room?.phase === "closed") return;
    let cancelled = false;
    const beat = async () => {
      const before = Date.now();
      try {
        const result = await utils.client.game.heartbeat.mutate({ roomId });
        if (!cancelled) setOffset(result.serverNow - (before + Date.now()) / 2);
      } catch {
        if (!cancelled) {
          setConnection("reconnecting");
          void refetchSession();
          reset();
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
  }, [streamStatus, room?.phase, roomId, utils.client, reset, refetchSession]);
  useEffect(() => {
    const offline = () => setConnection("disconnected");
    const online = () => {
      setConnection("reconnecting");
      reset();
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [reset]);
  return {
    room,
    lobby,
    account,
    session,
    connection: session.error ? ("disconnected" as const) : connection,
    offset,
    error: error || (session.error?.message ?? ""),
    setError,
    retry: () => {
      setError("");
      void refetchSession();
      reset();
    },
    nickname:
      editedName ??
      (account?.user.name ?? "")
        .slice(0, 24)
        .replace(/[\p{C}]/gu, "")
        .trim(),
    setNickname: setEditedName,
  };
}
