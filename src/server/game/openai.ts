// Shared server-side transport. Callers own validation, deadlines and error policy.
export function requestResponse(
  apiKey: string,
  body: Record<string, unknown>,
  signal: AbortSignal,
  transport: typeof fetch = fetch,
) {
  return transport("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    signal,
    body: JSON.stringify({ ...body, store: false }),
  });
}
