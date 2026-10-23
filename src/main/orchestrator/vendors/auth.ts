import type { Transport, ProviderCapability } from "./types";

export function authHeaderFor(cap: ProviderCapability, apiKey: string,
  transport: Transport = cap.transport): Record<string, string> {
  if (!apiKey) return {};
  let style = cap.authStyle;
  if (transport === "anthropic") style = cap.anthropicAuthStyle ?? cap.authStyle;
  if (style === "bearer") return { Authorization: "Bearer " + apiKey };
  if (style === "x-api-key") return { "x-api-key": apiKey };
  throw new Error(`[vendors/auth] Provider "${cap.displayName}" has invalid authStyle: ${JSON.stringify(style)} (expected "bearer" | "x-api-key")`);
}
