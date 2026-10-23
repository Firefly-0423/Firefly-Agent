import type { SavedModelProfile } from "./model-catalog";
import { SPECIALIST_AGENTS, type AgentRoutingView, type AgentRoutingUpdate } from "../../shared/specialist-agents";

export interface AgentModelRoutingSettings {
  modelProfiles?: SavedModelProfile[];
  defaultModelProfileId?: string;
  agentModelProfiles?: Record<string, string>;
  specialistModelProfiles?: Record<string, string>;
}

export function normalizeAgentModelProfiles(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([name, profileId]) =>
    name.trim() && typeof profileId === "string" && profileId.trim()
      ? [[name, profileId.trim()]] : []));
}

/**
 * A route with its own binding uses that profile; every other route follows the saved default model, so the twelve
 * specialists work as soon as one model is set up and only the ones the user changes run on something else.
 * There is no silent "first profile" fallback: without a saved default the route stays unconfigured.
 */
export function resolveAgentModelProfile(settings: AgentModelRoutingSettings, route: string): SavedModelProfile {
  const routes = normalizeAgentModelProfiles(settings.agentModelProfiles);
  const profileId = Object.hasOwn(routes, route) ? routes[route] : settings.defaultModelProfileId;
  if (!profileId) throw new Error("AGENT_MODEL_ROUTE_UNCONFIGURED");
  const profile = settings.modelProfiles?.find(entry => entry.id === profileId);
  if (!profile) throw new Error("AGENT_MODEL_PROFILE_NOT_FOUND");
  if (!profile.provider?.trim() || !profile.baseUrl?.trim() || !profile.model?.trim()) {
    throw new Error("AGENT_MODEL_PROFILE_INCOMPLETE");
  }
  return { ...profile, ...(profile.reasoning ? { reasoning: { ...profile.reasoning } } : {}) };
}

export function resolveSpecialistModelProfile(
  settings: AgentModelRoutingSettings, agentId: string, route: string,
): SavedModelProfile {
  const overrides = normalizeAgentModelProfiles(settings.specialistModelProfiles);
  if (!Object.hasOwn(overrides, agentId)) return resolveAgentModelProfile(settings, route);
  return resolveAgentModelProfile({ ...settings, agentModelProfiles: { [route]: overrides[agentId] } }, route);
}

export function getAgentRoutingView(settings: AgentModelRoutingSettings): AgentRoutingView {
  const routes = normalizeAgentModelProfiles(settings.agentModelProfiles);
  const overrides = normalizeAgentModelProfiles(settings.specialistModelProfiles);
  const profiles = (settings.modelProfiles ?? []).map(profile => ({ id: profile.id, label: profile.displayName || `${profile.provider} / ${profile.model}` }));
  const labelCounts = new Map<string, number>();
  for (const profile of profiles) labelCounts.set(profile.label, (labelCounts.get(profile.label) ?? 0) + 1);
  return {
    profiles: profiles.map(profile => ({ ...profile, label: labelCounts.get(profile.label)! > 1 ? `${profile.label} [${profile.id}]` : profile.label })),
    routes: [...new Set(SPECIALIST_AGENTS.map(agent => agent.modelProfile))].map(id => ({ id, profileId: routes[id] })),
    agents: SPECIALIST_AGENTS.map(agent => {
      const entry = { ...agent, overrideProfileId: overrides[agent.id] };
      try {
        return { ...entry, effectiveProfileId: resolveSpecialistModelProfile(settings, agent.id, agent.modelProfile).id };
      } catch (error) {
        return { ...entry, error: error instanceof Error ? error.message : "AGENT_MODEL_ROUTE_UNAVAILABLE" };
      }
    }),
  };
}

export function updateAgentRouting(settings: AgentModelRoutingSettings, input: unknown): Partial<AgentModelRoutingSettings> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_AGENT_ROUTING_UPDATE");
  const update = input as Partial<AgentRoutingUpdate>;
  if (Object.keys(input).some(key => !["kind", "id", "profileId"].includes(key))
    || (update.kind !== "agent" && update.kind !== "route") || typeof update.id !== "string"
    || (update.profileId !== null && (typeof update.profileId !== "string" || !update.profileId.trim()))) {
    throw new Error("INVALID_AGENT_ROUTING_UPDATE");
  }
  const known = update.kind === "agent" ? SPECIALIST_AGENTS.some(agent => agent.id === update.id)
    : SPECIALIST_AGENTS.some(agent => agent.modelProfile === update.id);
  if (!known) throw new Error("UNKNOWN_AGENT_ROUTING_ID");
  if (update.profileId !== null) resolveAgentModelProfile({ ...settings, agentModelProfiles: { default: update.profileId } }, "default");
  const field = update.kind === "agent" ? "specialistModelProfiles" : "agentModelProfiles";
  const bindings = normalizeAgentModelProfiles(settings[field]);
  if (update.profileId === null) delete bindings[update.id];
  else bindings[update.id] = update.profileId;
  return { [field]: bindings };
}
