import { game } from "./service";

/** Install listener before reading the snapshot; coalesce updates for slow consumers. */
export async function* gameStream<T>(
  snapshot: () => T,
  signal?: AbortSignal,
  sessionId?: string,
) {
  let pending = true;
  let ended = signal?.aborted ?? false;
  let wake: (() => void) | undefined;
  let disconnect: (() => void) | undefined;
  const unlisten = game.listen(() => {
    pending = true;
    wake?.();
  });
  const close = () => {
    ended = true;
    unlisten();
    disconnect?.();
    wake?.();
  };
  signal?.addEventListener("abort", close, { once: true });
  try {
    if (!ended && sessionId) disconnect = game.connect(sessionId, close);
    while (!ended) {
      if (!pending)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      if (ended) break;
      pending = false;
      yield snapshot();
    }
  } finally {
    close();
    signal?.removeEventListener("abort", close);
  }
}
