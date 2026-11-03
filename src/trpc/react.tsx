"use client";

import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import {
  httpBatchStreamLink,
  httpSubscriptionLink,
  httpLink,
  splitLink,
  loggerLink,
} from "@trpc/client";
import { createTRPCReact } from "@trpc/react-query";
import { type inferRouterInputs, type inferRouterOutputs } from "@trpc/server";
import { useEffect, useRef, useState } from "react";
import SuperJSON from "superjson";

import { type AppRouter } from "~/server/api/root";
import { SERVER_ORIGIN } from "~/lib/game-config";
import { createQueryClient } from "./query-client";
import { authClient } from "~/server/better-auth/client";

let clientQueryClientSingleton: QueryClient | undefined = undefined;
const getQueryClient = () => {
  if (typeof window === "undefined") {
    // Server: always make a new query client
    return createQueryClient();
  }
  // Browser: use singleton pattern to keep the same query client
  clientQueryClientSingleton ??= createQueryClient();

  return clientQueryClientSingleton;
};

export const api = createTRPCReact<AppRouter>();

/**
 * Inference helper for inputs.
 *
 * @example type HelloInput = RouterInputs['example']['hello']
 */
export type RouterInputs = inferRouterInputs<AppRouter>;

/**
 * Inference helper for outputs.
 *
 * @example type HelloOutput = RouterOutputs['example']['hello']
 */
export type RouterOutputs = inferRouterOutputs<AppRouter>;

export function TRPCReactProvider(props: { children: React.ReactNode }) {
  const queryClient = getQueryClient();
  const { data: account, isPending: accountPending } = authClient.useSession();
  const previousAccount = useRef<string | null | undefined>(undefined);
  const accountId = account?.user.id ?? null;
  const [readyAccount, setReadyAccount] = useState<string | null>();
  useEffect(() => {
    if (accountPending) return;
    let cancelled = false;
    const previous = previousAccount.current;
    previousAccount.current = accountId;
    const prepare = async () => {
      if (previous !== undefined && previous !== accountId) {
        // Unmount account consumers before canceling/resetting their cached data.
        // In particular, an old accepted invitation must never navigate a new user.
        await queryClient.cancelQueries();
        await queryClient.resetQueries();
      }
      if (!cancelled) setReadyAccount(accountId);
    };
    void prepare();
    return () => {
      cancelled = true;
    };
  }, [accountPending, accountId, queryClient]);

  const [trpcClient] = useState(() =>
    api.createClient({
      links: [
        loggerLink({
          // Never log operator password inputs (including on failed responses).
          enabled: (op) =>
            op.direction === "up" &&
            op.path !== "game.login" &&
            process.env.NODE_ENV === "development",
        }),
        splitLink({
          condition: (op) => op.path.startsWith("messages."),
          true: splitLink({
            condition: (op) => op.type === "subscription",
            true: httpSubscriptionLink({
              transformer: SuperJSON,
              url: SERVER_ORIGIN + "/api/messages",
              eventSourceOptions: { withCredentials: true },
            }),
            false: httpLink({
              transformer: SuperJSON,
              url: SERVER_ORIGIN + "/api/messages",
              fetch: (url, options) =>
                fetch(url, { ...options, credentials: "include" }),
            }),
          }),
          false: splitLink({
            condition: (op) => op.type === "subscription",
            true: httpSubscriptionLink({
              transformer: SuperJSON,
              url: SERVER_ORIGIN + "/api/trpc",
              eventSourceOptions: { withCredentials: true },
            }),
            false: splitLink({
              condition: (op) =>
                [
                  "game.session",
                  "game.setGuestName",
                  "game.login",
                  "game.logout",
                ].includes(op.path),
              true: httpLink({
                transformer: SuperJSON,
                url: SERVER_ORIGIN + "/api/trpc",
                fetch: (url, options) =>
                  fetch(url, { ...options, credentials: "include" }),
              }),
              false: httpBatchStreamLink({
                transformer: SuperJSON,
                url: SERVER_ORIGIN + "/api/trpc",
                fetch: (url, options) =>
                  fetch(url, { ...options, credentials: "include" }),
                headers: () => ({ "x-trpc-source": "nextjs-react" }),
              }),
            }),
          }),
        }),
      ],
    }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <api.Provider client={trpcClient} queryClient={queryClient}>
        {accountPending || readyAccount === accountId ? (
          props.children
        ) : (
          <p role="status">Updating account…</p>
        )}
      </api.Provider>
    </QueryClientProvider>
  );
}
