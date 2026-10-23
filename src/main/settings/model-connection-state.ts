import { createHash } from "node:crypto";
import { normalizeReasoningPreference } from "../../shared/reasoning";
import type { ModelConnectionSnapshot, ModelProfileConnection } from "../../shared/model-connection-types";
import { getCapabilityOrOpenAI } from "../orchestrator/vendors/capabilities";
import type { TestConnectionResult, VendorConfig } from "../orchestrator/vendors/types";
import type { SavedModelProfile } from "./model-catalog";

/** Clone the exact request dimensions; the same snapshot is matched and sent. */
export function normalizeConnectionConfig(input: unknown): VendorConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("MODEL_CONNECTION_INVALID_CONFIG");
  const raw = input as Record<string, unknown>;
  const strings = ["provider", "baseUrl", "model", "apiKey"] as const;
  if (strings.some((key) => typeof raw[key] !== "string" || !(raw[key] as string).trim())) throw new Error("MODEL_CONNECTION_INVALID_CONFIG");
  if (raw.explicitTransport !== undefined && !["openai", "anthropic", "responses"].includes(raw.explicitTransport as string)) throw new Error("MODEL_CONNECTION_INVALID_CONFIG");
  const reasoning = normalizeReasoningPreference(raw.reasoning);
  if (raw.reasoning !== undefined) {
    const value = raw.reasoning as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || Array.isArray(value) || !reasoning
      || Object.keys(value).some((key) => !["mode", "effort"].includes(key))
      || (value.effort !== undefined && value.effort !== reasoning.effort)) throw new Error("MODEL_CONNECTION_INVALID_CONFIG");
  }
  const provider = (raw.provider as string).trim();
  return { provider, baseUrl: (raw.baseUrl as string).trim(), model: (raw.model as string).trim(), apiKey: (raw.apiKey as string).trim(),
    explicitTransport: raw.explicitTransport as VendorConfig["explicitTransport"] ?? getCapabilityOrOpenAI(provider).transport,
    ...(reasoning ? { reasoning } : {}),
  };
}
function fingerprint(config: VendorConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}
function profileFingerprint(profile: SavedModelProfile): string | null {
  try { return fingerprint(normalizeConnectionConfig(profile)); } catch { return null; }
}
interface Entry { public: ModelProfileConnection; fingerprint: string | null; attempt: number; }
/** Process-local results of explicit tests. Never persisted and never schedules I/O. */
export function createModelConnectionState() {
  const entries = new Map<string, Entry>();
  const listeners = new Set<(snapshot: ModelConnectionSnapshot) => void>();
  let revision = 0;
  let attempt = 0;
  let defaultProfileId: string | undefined;
  function snapshot(): ModelConnectionSnapshot {
    return { ...(defaultProfileId ? { defaultProfileId } : {}), profiles: [...entries.values()].map((entry) => ({ ...entry.public, configured: entry.fingerprint !== null })) };
  }
  function publish() {
    for (const listener of listeners) {
      try { listener(snapshot()); } catch { console.warn("[Firefly] model connection listener failed"); }
    }
  }
  return {
    snapshot,
    subscribe(listener: (snapshot: ModelConnectionSnapshot) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh(profiles: SavedModelProfile[], effectiveDefault?: string) {
      const before = JSON.stringify(snapshot());
      const ids = new Set(profiles.map((profile) => profile.id));
      for (const id of entries.keys()) if (!ids.has(id)) entries.delete(id);
      // Duplicate IDs are ambiguous too; they must not inherit a verified identity.
      for (const profile of profiles) {
        const key = profiles.filter((other) => other.id === profile.id).length === 1 ? profileFingerprint(profile) : null;
        const previous = entries.get(profile.id);
        if (!previous || previous.fingerprint !== key) entries.set(profile.id, { public: { profileId: profile.id, revision: ++revision, state: "unverified" }, fingerprint: key, attempt: 0 });
      }
      defaultProfileId = effectiveDefault;
      if (JSON.stringify(snapshot()) !== before) publish();
    },
    isConnected(profile: SavedModelProfile | undefined) {
      if (!profile) return false;
      const entry = entries.get(profile.id);
      return entry?.public.state === "connected" && entry.fingerprint !== null && entry.fingerprint === profileFingerprint(profile);
    },
    async test(config: VendorConfig, driver: (config: VendorConfig) => Promise<TestConnectionResult>): Promise<TestConnectionResult> {
      const key = fingerprint(config);
      const matches = [...entries.values()].filter((entry) => entry.fingerprint === key);
      const entry = matches.length === 1 ? matches[0] : undefined;
      const started = ++attempt;
      if (entry) { entry.attempt = started; entry.public = { profileId: entry.public.profileId, revision: entry.public.revision, state: "checking" }; publish(); }
      const start = Date.now();
      let result: TestConnectionResult;
      let reason: "test_failed" | "test_error" | undefined;
      try {
        const response = await driver(config);
        const ok = response.ok === true;
        const latency = Number.isFinite(response.latency) && response.latency >= 0 ? response.latency : Date.now() - start;
        reason = ok ? undefined : "test_failed";
        result = { ok, latency, ...(ok ? {} : { error: "MODEL_CONNECTION_TEST_FAILED" }) };
      } catch {
        reason = "test_error";
        result = { ok: false, latency: Date.now() - start, error: "MODEL_CONNECTION_TEST_ERROR" };
      }
      if (entry && entries.get(entry.public.profileId) === entry && entry.attempt === started) {
        entry.public = { profileId: entry.public.profileId, revision: entry.public.revision, state: result.ok ? "connected" : "failed", checkedAt: Date.now(), ...(reason ? { reason } : {}) };
        publish();
      }
      return result;
    },
  };
}