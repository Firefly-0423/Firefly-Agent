import { PluginError } from "../../../shared/plugin-protocol";

/** Sliding window shared by generate/run; caller admits only authorized, configured requests. */
export function createRateLimiter(limitPerMinute: (pluginId: string) => number = () => 10, now = Date.now) {
  const calls = new Map<string, number[]>();
  return (pluginId: string): void => {
    const setting = limitPerMinute(pluginId);
    const limit = Number.isInteger(setting) && setting >= 1 && setting <= 60 ? setting : 10;
    const instant = now();
    const recent = (calls.get(pluginId) ?? []).filter(time => instant - time < 60_000);
    if (recent.length >= limit) throw new PluginError("ERR_RATE_LIMITED", "Model usage limit reached", true);
    recent.push(instant); calls.set(pluginId, recent);
  };
}
