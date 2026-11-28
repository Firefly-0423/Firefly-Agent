/** Cancellation races keep observing the source after the caller stops waiting. */
export function createAbortError(): Error {
  const failure = new Error("Operation aborted");
  failure.name = "AbortError";
  return failure;
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof Error) return error.name === "AbortError";
  return false;
}

export function isCancellationError(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true ? true : isAbortError(error);
}

function observeUntilAbort<T>(source: Promise<T>, cancellation: AbortSignal): Promise<T> {
  return new Promise<T>((accept, decline) => {
    let waiting = true;
    const complete = (apply: () => void): void => {
      if (!waiting) return;
      waiting = false;
      cancellation.removeEventListener("abort", cancelled);
      apply();
    };
    const cancelled = (): void => complete(() => decline(createAbortError()));
    cancellation.addEventListener("abort", cancelled, { once: true });
    source.then(
      result => complete(() => accept(result)),
      reason => complete(() => decline(reason)),
    );
  });
}

export function raceWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal) {
    if (signal.aborted) return Promise.reject(createAbortError());
    return observeUntilAbort(promise, signal);
  }
  return promise;
}
