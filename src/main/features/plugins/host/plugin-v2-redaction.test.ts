import path from "node:path";
import { describe, expect, it } from "vitest";
import { createPluginStreamRedactor, redactPluginText } from "./plugin-v2-redaction";

describe("plugin-v2 redaction", () => {
  const workspaceRoot = path.join("D:", "projects", "firefly-app");
  const source = {
    loadModelSettings: () => ({
      apiKey: "sk-live-secret-998877",
      modelProfiles: [{ apiKey: "sk-profile-token-4455" }],
    }),
    loadGeneralSettings: () => ({
      searchTavilyKey: "tvly-secret-1234",
      amapKey: "",
    }),
    protectedRoots: [path.join("C:", "Users", "alice", "AppData", "Roaming", "Firefly-1.2.0")],
  };

  it("redacts real model/general credentials and foreign paths while preserving workspace paths", () => {
    const insidePath = path.join(workspaceRoot, "src", "index.ts");
    const foreignPath = "C:\\Users\\alice\\Desktop\\passwords.txt";
    const text = `key=sk-live-secret-998877 tavily=tvly-secret-1234 work=${insidePath} outside=${foreignPath}`;
    const redacted = redactPluginText(text, { workspaceRoot }, source);

    expect(redacted).not.toContain("sk-live-secret-998877");
    expect(redacted).not.toContain("tvly-secret-1234");
    expect(redacted).not.toContain(foreignPath);
    expect(redacted).toContain("[REDACTED]");
    expect(redacted).toContain("[REDACTED_PATH]");
    expect(redacted).toContain(insidePath);
  });

  it("redacts all filesystem paths when workspaceRoot is null", () => {
    const redacted = redactPluginText("see /Users/alice/secret.env and https://example.com/docs", { workspaceRoot: null }, source);
    expect(redacted).toBe("see [REDACTED_PATH] and https://example.com/docs");
  });

  it("retains undecidable suffixes across stream chunks for split credentials and foreign paths", () => {
    const redactor = createPluginStreamRedactor({ workspaceRoot }, source);

    const c1 = redactor.push("token is sk-live-sec");
    expect(c1).toBe("token is ");
    expect(c1).not.toContain("sk-live-sec");

    const c2 = redactor.push("ret-998877 and C:\\Users\\alice");
    expect(c2).toBe("[REDACTED] and ");
    expect(c2).not.toContain("sk-live-secret-998877");
    expect(c2).not.toContain("Users");

    const c3 = redactor.push("\\secret.txt done");
    expect(c3).toBe("[REDACTED_PATH] done");
    expect(redactor.finish()).toBe("");
  });

  it("flushes safe buffered tail on finish() only", () => {
    const redactor = createPluginStreamRedactor({ workspaceRoot }, source);
    expect(redactor.push("note C")).toBe("note ");
    expect(redactor.finish()).toBe("C");
  });
});
