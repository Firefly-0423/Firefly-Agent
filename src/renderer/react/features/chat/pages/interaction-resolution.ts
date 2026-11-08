type ResolutionHost = { busy(value: boolean): void; clear(): void; resume(): void };

/** A rejected bridge call leaves the card in place so the user can retry. */
export function resolveInteraction(call: () => Promise<{ ok: boolean }>, host: ResolutionHost): Promise<void> {
  host.busy(true);
  return call().then(result => {
    if (result.ok) host.resume();
    host.clear();
    host.busy(false);
  }).catch(() => host.busy(false));
}
