/** Install a scoped listener before connecting/snapshotting; retain only the latest update. */
export async function* gameStream<T>(options: {
  snapshot: () => T;
  listen: (listener: () => void) => () => void;
  connect?: (close: () => void) => () => void;
  signal?: AbortSignal;
  isTerminal?: (snapshot: T) => boolean;
}) {
  let latest: T | undefined;
  let pending = false;
  let ended = options.signal?.aborted ?? false;
  let wake: (() => void) | undefined;
  let disconnect: (() => void) | undefined;
  const unlisten = options.listen(() => {
    latest = options.snapshot();
    pending = true;
    wake?.();
  });
  const close = () => {
    if (ended) return;
    ended = true;
    unlisten();
    disconnect?.();
    wake?.();
  };
  options.signal?.addEventListener("abort", close, { once: true });
  try {
    if (!ended) {
      disconnect = options.connect?.(close);
      latest = options.snapshot();
      pending = true;
    }
    while (!ended || pending) {
      if (!pending)
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      if (pending && !options.signal?.aborted) {
        const value = latest!;
        pending = false;
        yield value;
        if (options.isTerminal?.(value)) return;
      } else if (ended) break;
    }
  } finally {
    close();
    unlisten();
    disconnect?.();
    options.signal?.removeEventListener("abort", close);
  }
}
