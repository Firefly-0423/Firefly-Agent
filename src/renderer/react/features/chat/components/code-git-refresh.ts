export type CodeGitRefreshController = { dispose(): void; request(): void };

export function createCodeGitRefreshController<T>(input: {
  load(): Promise<T>; apply(value: T): void;
  failed(): void; busy(value: boolean): void;
}): CodeGitRefreshController {
  let active = false;
  let again = false;
  let closed = false;

  function refresh() {
    if (closed || active) return;
    active = true;
    input.busy(true);
    const loaded = input.load().then((next) => {
      if (!closed) input.apply(next);
    });
    const handled = loaded.catch(() => {
      if (!closed) input.failed();
    });
    void handled.finally(() => {
      active = false;
      if (!closed) input.busy(false);
      if (again && !closed) {
        again = false;
        refresh();
      }
    });
  }

  return {
    request() {
      if (!active) refresh();
      else again = true;
    },
    dispose() { closed = true; again = false; },
  };
}
