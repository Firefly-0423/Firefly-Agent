import { describe, it, expect, vi } from "vitest";
import { testVendorConnection } from "./test-connection";
import type { ChatVendorAdapter, VendorConfig } from "./types";

describe("Connection checks through the runtime adapter", () => {
  it("passes the complete selected configuration through both dispatch stages", async () => {
    const selected: VendorConfig = { provider: "MiniMax（稀宇科技）", model: "MiniMax-M3", baseUrl: "https://api.minimaxi.com/v1", apiKey: "agenda-credential", explicitTransport: "openai", reasoning: { mode: "off" } };
    const probe = vi.fn().mockResolvedValue({ ok: true, latency: 12 });
    const resolver = vi.fn(() => ({ transport: "openai", testConnection: probe }) as unknown as ChatVendorAdapter);
    await testVendorConnection(selected, resolver);
    expect(resolver).toHaveBeenCalledWith(selected);
    expect(probe).toHaveBeenCalledWith(selected);
  });

  it("logs neither user configuration nor upstream error and sample text", async () => {
    const logging = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const selected: VendorConfig = { provider: "credential-canary", model: "credential-canary", baseUrl: "https://credential-canary.invalid", apiKey: "credential-canary" };
      const resolver = () => ({ transport: "openai", testConnection: async () => ({ ok: false, latency: 12, error: "credential-canary upstream-private", sample: "sensitive-sample" }) }) as unknown as ChatVendorAdapter;
      await testVendorConnection(selected, resolver);
      expect(JSON.stringify(logging.mock.calls)).not.toMatch(/credential-canary|upstream-private|sample/);
    } finally { logging.mockRestore(); }
  });
});
