export type Live2DDisposerKind = "listener" | "subscription" | "resource";
export interface Live2DRendererLifecycleDiagnostics {
  labels: string[];
  resourceCount: number;
  subscriptionCount: number;
  listenerCount: number;
  activeDisposers: number;
}

type Cleanup = { kind: Live2DDisposerKind; label: string; run: () => void };
export class Live2DRendererLifecycleTracker {
  private registry = new Map<number, Cleanup>();
  private serial = 1;

  track(kind: Live2DDisposerKind, label: string, dispose: () => void): () => void {
    const token = this.serial++;
    this.registry.set(token, { kind, label, run: dispose });
    return () => this.release(token);
  }
  disposeAll(): void {
    const tokens = [...this.registry.keys()];
    tokens.forEach((token) => this.release(token));
  }
  getDiagnostics(): Live2DRendererLifecycleDiagnostics {
    const snapshot = [...this.registry.values()];
    const totals = { listener: 0, subscription: 0, resource: 0 };
    const names: string[] = [];
    for (const cleanup of snapshot) {
      totals[cleanup.kind] += 1;
      names.push(cleanup.label);
    }
    return {
      activeDisposers: snapshot.length,
      listenerCount: totals.listener,
      subscriptionCount: totals.subscription,
      resourceCount: totals.resource,
      labels: names,
    };
  }
  private release(token: number): void {
    const cleanup = this.registry.get(token);
    if (cleanup === undefined) return;
    this.registry.delete(token);
    cleanup.run();
  }
}
