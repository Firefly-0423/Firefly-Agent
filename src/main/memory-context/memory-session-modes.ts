import { parseInternalId } from "../memory-core/command-validation";

export type MemorySessionMode = "persistent" | "temporary";
export interface MemorySessionModeBinding { readonly mode: MemorySessionMode; readonly revision: number }

/** Main owns bindings; a run DTO cannot grant itself persistent memory. */
export function createMemorySessionModes() {
  const bindings = new Map<string, Readonly<MemorySessionModeBinding>>();
  let revision = 0;
  const denied = (): never => { throw new Error("MEMORY_SESSION_MODE_DENIED"); };
  function capture(sessionId: string): Readonly<MemorySessionModeBinding> {
    return bindings.get(parseInternalId(sessionId)) ?? denied();
  }
  return Object.freeze({
    bind(sessionId: string, mode: MemorySessionMode): void {
      const id = parseInternalId(sessionId);
      if (mode !== "persistent" && mode !== "temporary") denied();
      const existing = bindings.get(id);
      if (existing) { if (existing.mode !== mode) denied(); return; }
      bindings.set(id, Object.freeze({ mode, revision: ++revision }));
    },
    require(sessionId: string): MemorySessionMode { return capture(sessionId).mode; },
    capture,
    remove(sessionId: string): void { bindings.delete(parseInternalId(sessionId)); },
  });
}
export type MemorySessionModes = ReturnType<typeof createMemorySessionModes>;
