import { describe, it, expect } from "vitest";
import { ContextRefRegistry } from "./context-ref-registry";

describe("Conversation-scoped context handles", () => {
  function put(registry: ContextRefRegistry, conversationId = "room-blue", kind = "candidate", value: unknown = { album: "orbit", trackId: "982341" }) {
    return registry.issue({ conversationId, kind, value, domain: "music", expiresAt: 750 });
  }

  it("limits eviction and explicit clearing to the requested conversation", () => {
    let next = 0;
    const registry = new ContextRefRegistry({ now: () => 700, maxRefsPerConversation: 2, createId: () => "ctx_handle_" + next++ });
    const isolated = put(registry, "room-gold", "candidate", 84);
    const evicted = put(registry);
    const retained = put(registry, "room-blue", "candidate", "retained song");
    put(registry);
    expect(() => registry.resolve(evicted, "room-blue")).toThrow("E_CONTEXT_REF_NOT_FOUND");
    expect(registry.resolve(isolated, "room-gold")).toBe(84);
    expect(registry.resolve(retained, "room-blue")).toBe("retained song");
    registry.clear("room-blue");
    expect(() => registry.resolve(retained, "room-blue")).toThrow("E_CONTEXT_REF_NOT_FOUND");
    expect(registry.resolve(isolated, "room-gold")).toEqual(84);
    registry.clear();
    expect(() => registry.resolve(isolated, "room-gold")).toThrow("E_CONTEXT_REF_NOT_FOUND");
  });

  it("creates opaque handles and enforces conversation ownership", () => {
    const registry = new ContextRefRegistry({ now: () => 700 });
    const handle = put(registry);
    expect(handle).toMatch(/^ctx_/);
    expect(handle).not.toContain("982341");
    expect(registry.resolve(handle, "room-blue")).toEqual({ album: "orbit", trackId: "982341" });
    expect(() => registry.resolve(handle, "room-gold")).toThrow(/conversation/i);
  });

  it("rejects unknown handles and expires a handle at its deadline", () => {
    let clock = 749;
    const registry = new ContextRefRegistry({ now: () => clock });
    const handle = put(registry);
    expect(registry.resolve(handle, "room-blue")).toBeDefined();
    clock = 750;
    expect(() => registry.resolve(handle, "room-blue")).toThrow("E_CONTEXT_REF_EXPIRED");
    expect(() => registry.resolve("ctx_never_issued", "room-blue")).toThrow("E_CONTEXT_REF_NOT_FOUND");
    clock = 751;
    expect(() => registry.resolve(handle, "room-blue")).toThrow("E_CONTEXT_REF_NOT_FOUND");
  });

  it("checks requested kinds in both directions and permits untyped retrieval", () => {
    const registry = new ContextRefRegistry({ now: () => 700 });
    const song = put(registry);
    const selection = put(registry, "room-blue", "selection_set", { playlist: "night-drive" });
    expect(registry.resolve(song, "room-blue", "candidate")).toEqual({ album: "orbit", trackId: "982341" });
    for (const [handle, wrongKind] of [[song, "selection_set"], [selection, "candidate"]]) {
      expect(() => registry.resolve(handle, "room-blue", wrongKind)).toThrow("E_CONTEXT_REF_KIND_MISMATCH");
    }
    expect(registry.resolve(selection, "room-blue")).toEqual({ playlist: "night-drive" });
    expect(registry.resolve(song, "room-blue")).toEqual({ album: "orbit", trackId: "982341" });
  });
});
