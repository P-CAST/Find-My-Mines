import { createApiHandler } from "~/server/api/handler";
import { gameApiRouter } from "~/server/api/root";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handler = createApiHandler("/api/trpc", gameApiRouter);
export { handler as GET, handler as POST };
