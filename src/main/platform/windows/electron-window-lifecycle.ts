export type TrackedWebContentsLike = {
  isDestroyed?: () => boolean;
  id?: number;
};
export type TrackedBrowserWindowLike = {
  on: (event: "closed", listener: () => void) => unknown;
  isDestroyed: () => boolean;
  webContents?: TrackedWebContentsLike;
};
export type WindowLifecycleDiagnostics = {
  closedCount: number;
  webContentsDestroyed: boolean | null;
  webContentsId: number | null;
  windowDestroyed: boolean | null;
  attached: boolean;
  name: string;
};

export function createWindowLifecycleTracker<TWindow extends TrackedBrowserWindowLike>(
  name: string,
  options: { onClosed?: (win: TWindow) => void } = {},
) {
  let selected: TWindow | null = null;
  let closures = 0;
  const detach = (candidate?: TWindow): void => {
    if (!candidate || candidate === selected) selected = null;
  };
  const watch = (candidate: TWindow): TWindow => {
    selected = candidate;
    candidate.on("closed", () => {
      closures += 1;
      detach(candidate);
      options.onClosed?.(candidate);
    });
    return candidate;
  };
  const inspect = (): WindowLifecycleDiagnostics => {
    return {
      name: name,
      attached: selected !== null,
      windowDestroyed: selected ? selected.isDestroyed() : null,
      webContentsId: selected?.webContents?.id ?? null,
      webContentsDestroyed: selected?.webContents?.isDestroyed?.() ?? null,
      closedCount: closures,
    };
  };
  return { attach: watch, clear: detach, getWindow: (): TWindow | null => selected, getDiagnostics: inspect };
}
