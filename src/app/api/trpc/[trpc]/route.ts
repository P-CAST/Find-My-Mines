import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { type NextRequest } from "next/server";
import { env } from "~/env";
import { appRouter } from "~/server/api/root";
import { createTRPCContext } from "~/server/api/trpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = async (req: NextRequest) => {
  // Cookie-authenticated commands must come from the page's own origin.
  const origin = req.headers.get("origin");
  // Next may construct req.nextUrl with localhost even when reached over the LAN.
  const requestOrigin = new URL(req.url);
  requestOrigin.host = req.headers.get("host") ?? requestOrigin.host;
  if (origin && origin !== requestOrigin.origin)
    return new Response("Use the configured application origin.", {
      status: 403,
    });
  const responseHeaders = new Headers();
  const response = await fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
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
export { handler as GET, handler as POST };
