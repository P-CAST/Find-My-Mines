import { requireOperatorAccount } from "~/lib/operator";
import { auth } from "./config";

/** Always consult persisted sessions and roles, including for long-lived SSE. */
export async function getOperatorSession(headers: Headers) {
  return auth.api.getSession({
    headers,
    query: { disableCookieCache: true, disableRefresh: true },
  });
}

export async function requireOperator(headers: Headers) {
  return requireOperatorAccount(await getOperatorSession(headers));
}
