import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { vendorConfigFromSettings } from "./vendor-config";

// Every request path must build its model config with vendorConfigFromSettings: the memory runtime binds that exact
// shape and refuses any other with MEMORY_CONTEXT_REQUEST_CHANGED. A hand-written literal silently drops a field
// (1.1.3 partners lost reasoningLevels and every delegation failed), so none may exist in Main.
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

describe("vendorConfigFromSettings", () => {
  it("keeps reasoning levels and omits absent optional fields", () => {
    expect(vendorConfigFromSettings({ provider: "p", baseUrl: "u", model: "m", apiKey: "",
      reasoning: { mode: "on", effort: "high" } as never, reasoningLevels: { efforts: ["low", "high"] } as never }))
      .toStrictEqual({ provider: "p", baseUrl: "u", model: "m", apiKey: "",
        reasoning: { mode: "on", effort: "high" }, reasoningLevels: { efforts: ["low", "high"] } });
    expect(Object.keys(vendorConfigFromSettings({ provider: "p", baseUrl: "u", model: "m", apiKey: "" })))
      .toEqual(["provider", "baseUrl", "model", "apiKey"]);
  });
  it("is the only way Main builds a vendor config passed to a run", () => {
    const literal = /\bvendorConfig\s*:\s*\{/;
    const offenders = sources(path.resolve("src/main")).filter(file => literal.test(fs.readFileSync(file, "utf8")))
      .map(file => path.relative(process.cwd(), file));
    expect(offenders).toEqual([]);
  });
});
