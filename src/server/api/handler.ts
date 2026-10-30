import { type AnyTRPCRouter } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { type NextRequest } from "next/server";
import { env } from "~/env";
import { createTRPCContext } from "~/server/api/trpc";

export function createApiHandler(endpoint: string, router: AnyTRPCRouter) {
  return async (req: NextRequest) => {
    const origin = req.headers.get("origin");
    // Next may construct req.nextUrl with localhost when reached over the LAN.
    const requestOrigin = new URL(req.url);
    requestOrigin.host = req.headers.get("host") ?? requestOrigin.host;
    if (origin && origin !== requestOrigin.origin)
      return new Response("Use the configured application origin.", {
        status: 403,
      });
    const responseHeaders = new Headers();
    const response = await fetchRequestHandler({
      endpoint,
      req,
      router,
      createContext: () =>
        createTRPCContext({
          headers: req.headers,
          responseHeaders,
          secure: req.nextUrl.protocol === "https:",
        }),
      responseMeta: () => ({ headers: responseHeaders }),
      onError:
        env.NODE_ENV === "development"
          ? ({ path, error }) => {
              console.error(`[tRPC] ${path ?? "unknown"}: ${error.message}`);
            }
          : undefined,
    });
    response.headers.set("Cache-Control", "no-store, no-transform");
    response.headers.set("X-Accel-Buffering", "no");
    return response;
  };
}
