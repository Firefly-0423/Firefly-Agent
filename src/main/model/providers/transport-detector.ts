import { getCapabilityOrOpenAI } from "./capabilities";
import type { Transport } from "./types";

export function resolveTransport(cfg: {
  provider: string;
  explicitTransport?: Transport;
  baseUrl: string;
}): Transport {
  switch (cfg.explicitTransport) {
    case "responses": return "responses";
    case "anthropic": return "anthropic";
    case "openai": return "openai";
    default: return getCapabilityOrOpenAI(cfg.provider).transport;
  }
}
