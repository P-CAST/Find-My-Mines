/** Install a scoped listener before connecting/snapshotting; retain only the latest update. */
export async function* gameStream<T>(options: {
  snapshot: () => T;
  listen: (listener: () => void) => () => void;
  connect?: (close: () => void) => () => void;
  signal?: AbortSignal;
  isTerminal?: (snapshot: T) => boolean;
  authorize?: () => Promise<unknown>;
}) {
  let latest: T | undefined;
  let pending = false;
  let ended = options.signal?.aborted ?? false;
  let wake: (() => void) | undefined;
  let disconnect: (() => void) | undefined;
  let validation: Promise<unknown> | undefined;
  let authorizationError: unknown;
  let failedAuthorization = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const authorize = () => {
    validation ??= options.authorize!().finally(() => {
      validation = undefined;
    });
    return validation;
  };
  const unlisten = options.listen(() => {
    latest = options.snapshot();
    pending = true;
    wake?.();
  });
  const close = () => {
    if (ended) return;
    ended = true;
    clearInterval(timer);
    unlisten();
    disconnect?.();
    wake?.();
  };
  options.signal?.addEventListener("abort", close, { once: true });
  try {
    if (options.authorize && !ended) {
      await authorize();
      if (!ended) {
        timer = setInterval(() => {
          void authorize().catch((error: unknown) => {
            authorizationError = error;
            failedAuthorization = true;
            pending = false;
            close();
          });
        }, 5000);
        timer.unref();
      }
    }
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
        if (options.authorize) await authorize();
        if (options.signal?.aborted || failedAuthorization) break;
        const value = latest!;
        pending = false;
        yield value;
        if (options.isTerminal?.(value)) return;
      } else if (ended) break;
    }
    if (failedAuthorization) throw authorizationError;
  } finally {
    close();
    unlisten();
    disconnect?.();
    options.signal?.removeEventListener("abort", close);
  }
}
