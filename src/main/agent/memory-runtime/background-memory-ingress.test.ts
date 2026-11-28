import { describe, expect, it } from "vitest";
import { createBackgroundMemoryIngressIssuer, requireBackgroundMemoryIngress } from "./background-memory-ingress";

describe("Main background memory ingress", () => {
  it.each(["scheduler", "proactive", "child"] as const)("binds %s instructions to system/model trust and rejects copied proof", entry => {
    const source = {}, lifetime = new AbortController();
    let current = true;
    const issuer = createBackgroundMemoryIngressIssuer({ entry, isCurrent: candidate => current && candidate === source });
    const ingress = issuer.capture({ source, sessionId: `${entry}-session`, sourceKey: "trusted-source", instructionText: "I prefer PowerShell", signal: lifetime.signal });
    expect(requireBackgroundMemoryIngress(ingress)).toMatchObject({ entry, sessionId: `${entry}-session`, instructionText: "I prefer PowerShell", sourceTrust: entry === "child" ? "model" : "system" });
    expect(() => requireBackgroundMemoryIngress({ ...ingress })).toThrow("MEMORY_BACKGROUND_INGRESS_DENIED");
    current = false;
    expect(() => requireBackgroundMemoryIngress(ingress)).toThrow("MEMORY_BACKGROUND_INGRESS_DENIED");
  });
  it("rejects a cancelled producer and never accepts parent IDs as read authority", () => {
    const controller = new AbortController(), source = {};
    const issuer = createBackgroundMemoryIngressIssuer({ entry: "child", isCurrent: item => item === source });
    const ingress = issuer.capture({ source, sessionId: "child-session", sourceKey: "child-source", instructionText: "system task", signal: controller.signal });
    expect(requireBackgroundMemoryIngress(ingress)).not.toHaveProperty("readActorTokens");
    controller.abort();
    expect(() => requireBackgroundMemoryIngress(ingress)).toThrow("MEMORY_BACKGROUND_INGRESS_DENIED");
    expect(() => issuer.capture({ source, sessionId: "child-session", sourceKey: "child-source", instructionText: "system task", signal: controller.signal })).toThrow("MEMORY_BACKGROUND_INGRESS_DENIED");
  });
});
