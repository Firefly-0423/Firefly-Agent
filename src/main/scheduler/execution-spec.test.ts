import { it, expect } from "vitest";
import { computeExecutionSpecFingerprint as fingerprint, taskExecutionSpec as spec, pluginTaskTogglePatch as toggle,
  authorizePluginTaskUpdatePatch as authorize, isPluginTaskEffectivelyEnabled as pluginEnabled, isTaskEnabled as enabled } from "./execution-spec";
import type { ScheduledTask } from "./types";

function job(patch: Partial<ScheduledTask> = {}): ScheduledTask {
  return { id: "garden-review", title: "Garden review", prompt: "Review the seedlings", enabled: false,
    schedule: { kind: "daily", timeOfDay: "10:15" }, nextFireAt: "2026-10-21T02:15:00.000Z",
    toolMode: "allow-list", allowedToolIds: ["plant_lookup", "rain_check"], ownerPluginId: "garden-plugin",
    pluginUserEnabled: false, approvalFingerprint: "", mode: "work",
    createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z", ...patch };
}
it("hashes canonical schedule keys and sorted unique tool ids independently of display titles", () => {
  const original = fingerprint(spec(job()));
  expect(original).toMatch(/^[0-9a-f]{64}$/);
  expect(fingerprint({ ...spec(job()), schedule: { timeOfDay: "10:15", kind: "daily" },
    allowedToolIds: ["rain_check", "plant_lookup", "rain_check"] })).toBe(original);
  expect(fingerprint(spec(job({ title: "Renamed garden review" })))).toBe(original);
  for (const patch of [{ prompt: "Review the roses" }, { mode: "chat" as const }, { allowedToolIds: ["plant_lookup"] },
    { schedule: { kind: "daily" as const, timeOfDay: "10:45" } }]) {
    expect(fingerprint(spec(job(patch)))).not.toBe(original);
  }
});
it("defaults missing execution modes to work and retains explicit chat", () => {
  expect(spec(job({ mode: undefined })).mode).toBe("work");
  expect(spec(job({ mode: "chat" })).mode).toBe("chat");
});
it("requires both plugin approval and a matching current specification", () => {
  const hash = fingerprint(spec(job()));
  for (const patch of [{}, { pluginUserEnabled: true }, { approvalFingerprint: hash },
    { pluginUserEnabled: true, approvalFingerprint: hash, prompt: "Changed by plugin" },
    { ownerPluginId: undefined, pluginUserEnabled: undefined, enabled: true }]) {
    expect(pluginEnabled(job(patch))).toBe(false);
  }
  expect(pluginEnabled(job({ pluginUserEnabled: true, approvalFingerprint: hash }))).toBe(true);
});
it("uses raw enabled only for user tasks and effective authorization for plugin tasks", () => {
  expect(enabled(job({ ownerPluginId: undefined, pluginUserEnabled: undefined, approvalFingerprint: undefined }))).toBe(false);
  expect(enabled(job({ ownerPluginId: undefined, pluginUserEnabled: undefined, enabled: true }))).toBe(true);
  const hash = fingerprint(spec(job()));
  for (const diskEnabled of [false, true]) expect(enabled(job({ enabled: diskEnabled, pluginUserEnabled: true, approvalFingerprint: hash }))).toBe(true);
  expect(enabled(job({ pluginUserEnabled: false, approvalFingerprint: hash }))).toBe(false);
});
it("creates a matching authorization patch on enable and revokes only the authorization bit on disable", () => {
  const original = job(), patch = toggle(original, true);
  expect(patch.pluginUserEnabled).toBe(true);
  expect(patch.approvalFingerprint).toBe(fingerprint(spec(original)));
  expect(pluginEnabled({ ...original, ...patch })).toBe(true);
  expect(toggle(original, false)).toEqual({ pluginUserEnabled: false });
});
it("authorizes the merged specification and removes host-owned execution fields", () => {
  const original = job(), patch = authorize(original, { prompt: "Review the roses", pluginUserEnabled: true, enabled: true, toolMode: "all-enabled" });
  expect(patch.pluginUserEnabled).toBe(true);
  expect(patch.approvalFingerprint).toBe(fingerprint(spec({ ...original, prompt: "Review the roses" })));
  expect(patch.enabled).toBeUndefined();
  expect(patch.toolMode).toBeUndefined();
  expect(authorize(original, { mode: "chat", pluginUserEnabled: true }).approvalFingerprint)
    .toBe(fingerprint(spec({ ...original, mode: "chat" })));
});
it("renews existing authorization after an edit but leaves unapproved edits unapproved", () => {
  const approved = { ...job(), ...toggle(job(), true) };
  const schedule = { kind: "daily" as const, timeOfDay: "11:45" };
  const patch = authorize(approved, { schedule });
  expect(patch.pluginUserEnabled).toBe(true);
  expect(patch.approvalFingerprint).toBe(fingerprint(spec({ ...approved, schedule })));
  const unsigned = authorize(job(), { prompt: "Review new plants" });
  expect(unsigned.pluginUserEnabled).toBeUndefined();
  expect(unsigned.approvalFingerprint).toBeUndefined();
  expect(authorize(approved, { pluginUserEnabled: false }).pluginUserEnabled).toBe(false);
});
