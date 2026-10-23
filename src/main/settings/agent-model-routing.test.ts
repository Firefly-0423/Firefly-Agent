import { describe, expect, it } from "vitest";
import { resolveAgentModelProfile, normalizeAgentModelProfiles, resolveSpecialistModelProfile, getAgentRoutingView, updateAgentRouting } from "./agent-model-routing";

const profiles = [
  { id: "local-default", provider: "test", baseUrl: "http://127.0.0.1:12345", model: "test-model", apiKey: "" },
  { id: "local-code", provider: "test", baseUrl: "http://127.0.0.1:12345", model: "test-code-model", apiKey: "" },
];

describe("agent model routing", () => {
  it("returns twelve identity-only rows and validates single updates without leaking credentials", () => {
    const settings = { modelProfiles: profiles.map(profile => ({ ...profile, apiKey: "private-fixture" })),
      agentModelProfiles: { reasoning: "local-default" } };
    const view = getAgentRoutingView(settings);
    expect(view.agents).toHaveLength(12);
    expect(JSON.stringify(view)).not.toMatch(/private-fixture|baseUrl|apiKey/);
    const patch = updateAgentRouting(settings, { kind: "agent", id: "review", profileId: "local-code" });
    expect(patch.specialistModelProfiles).toEqual({ review: "local-code" });
    expect(resolveSpecialistModelProfile({ ...settings, ...patch }, "review", "reasoning").id).toBe("local-code");
    expect(resolveSpecialistModelProfile({ ...settings, ...patch }, "architecture", "reasoning").id).toBe("local-default");
    expect(() => updateAgentRouting(settings, { kind: "agent", id: "fake", profileId: "local-code" })).toThrow();
    expect(() => updateAgentRouting(settings, { kind: "route", id: "reasoning", profileId: "missing" })).toThrow();
    expect(() => updateAgentRouting(settings, { kind: "agent", id: "review", profileId: "local-code", apiKey: "forged" })).toThrow();
    expect(updateAgentRouting({ ...settings, ...patch }, { kind: "agent", id: "review", profileId: null }).specialistModelProfiles).toEqual({});
  });
  it("keeps per-agent overrides separate from abstract routes and fails on stale overrides", () => {
    const settings = { modelProfiles: profiles, agentModelProfiles: { research: "local-default" },
      specialistModelProfiles: { research: "local-code" } };
    expect(resolveSpecialistModelProfile(settings, "research", "research").id).toBe("local-code");
    expect(resolveSpecialistModelProfile(settings, "knowledge", "research").id).toBe("local-default");
    expect(() => resolveSpecialistModelProfile({ ...settings, specialistModelProfiles: { research: "removed" } }, "research", "research"))
      .toThrow("AGENT_MODEL_PROFILE_NOT_FOUND");
    expect(() => resolveSpecialistModelProfile({ modelProfiles: profiles }, "review", "reasoning"))
      .toThrow("AGENT_MODEL_ROUTE_UNCONFIGURED");
  });
  it("binds the explicit route to a saved profile without using the first model or another route", () => {
    const settings = { modelProfiles: profiles, defaultModelProfileId: "local-default", agentModelProfiles: { coding: "local-code" } };
    expect(resolveAgentModelProfile(settings, "coding")).toEqual(profiles[1]);
    expect(resolveAgentModelProfile(settings, "default")).toEqual(profiles[0]);
    // A route without its own binding follows the saved default model.
    expect(resolveAgentModelProfile(settings, "research")).toEqual(profiles[0]);
    expect(() => resolveAgentModelProfile({ ...settings, agentModelProfiles: { coding: "removed" } }, "coding"))
      .toThrow("AGENT_MODEL_PROFILE_NOT_FOUND");
  });

  it("lets every specialist follow the default model until one is given its own", () => {
    const settings = { modelProfiles: profiles, defaultModelProfileId: "local-default", specialistModelProfiles: { review: "local-code" } };
    const view = getAgentRoutingView(settings);
    expect(view.agents.filter(agent => agent.error)).toEqual([]);
    expect(view.agents.find(agent => agent.id === "review")?.effectiveProfileId).toBe("local-code");
    expect(view.agents.filter(agent => agent.id !== "review").every(agent => agent.effectiveProfileId === "local-default")).toBe(true);
    // The default moving moves every specialist that follows it.
    expect(resolveSpecialistModelProfile({ ...settings, defaultModelProfileId: "local-code" }, "architecture", "reasoning").id).toBe("local-code");
    // A default that no longer exists is reported, not replaced by some other profile.
    expect(() => resolveSpecialistModelProfile({ ...settings, defaultModelProfileId: "removed" }, "architecture", "reasoning"))
      .toThrow("AGENT_MODEL_PROFILE_NOT_FOUND");
  });

  it("does not silently select the first saved profile when the saved default is missing", () => {
    expect(() => resolveAgentModelProfile({ modelProfiles: profiles }, "default")).toThrow("AGENT_MODEL_ROUTE_UNCONFIGURED");
    expect(() => resolveAgentModelProfile({ modelProfiles: profiles, defaultModelProfileId: "removed" }, "default"))
      .toThrow("AGENT_MODEL_PROFILE_NOT_FOUND");
  });

  it("normalizes only own nonempty string bindings and does not alter provider settings", () => {
    const routing = Object.assign(Object.create({ research: "inherited" }), { coding: " local-code ", empty: "", secret: { apiKey: "fixture" } });
    expect(normalizeAgentModelProfiles(routing)).toEqual({ coding: "local-code" });
    expect(() => resolveAgentModelProfile({ modelProfiles: profiles, agentModelProfiles: routing }, "research"))
      .toThrow("AGENT_MODEL_ROUTE_UNCONFIGURED");
    const selected = resolveAgentModelProfile({ modelProfiles: profiles, defaultModelProfileId: "local-default" }, "default");
    selected.model = "changed";
    expect(profiles[0].model).toBe("test-model");
  });

  it("rejects incomplete saved models without inventing addresses or requiring a key for local providers", () => {
    expect(resolveAgentModelProfile({ modelProfiles: profiles, defaultModelProfileId: "local-default" }, "default").apiKey).toBe("");
    expect(() => resolveAgentModelProfile({ modelProfiles: [{ ...profiles[0], baseUrl: "" }], defaultModelProfileId: "local-default" }, "default"))
      .toThrow("AGENT_MODEL_PROFILE_INCOMPLETE");
  });
});
