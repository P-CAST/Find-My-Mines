import { createApiHandler } from "~/server/api/handler";
import { messagesApiRouter } from "~/server/api/root";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handler = createApiHandler("/api/messages", messagesApiRouter);
export { handler as GET, handler as POST };
