import { describe, expect, it } from "vitest";
import { urlForLog } from "./url-for-log";

describe("urlForLog", () => {
  it("keeps protocol and host, and only marks that a path was present", () => {
    expect(urlForLog("https://example.com/a/b.png")).toBe("https://example.com/<path>");
    expect(urlForLog("https://example.com/")).toBe("https://example.com");
  });

  it("drops path segments that may carry a share token", () => {
    const logged = urlForLog("https://files.example.com/s/SHARE-TOKEN-123/report.pdf");
    expect(logged).toBe("https://files.example.com/<path>");
    expect(logged).not.toContain("SHARE-TOKEN-123");
  });

  it("drops credentials, query values and fragments", () => {
    const logged = urlForLog("https://user:secret@example.com:8443/file?token=abc&x=1#frag");
    expect(logged).toBe("https://example.com:8443/<path>?<query>");
    expect(logged).not.toMatch(/secret|abc|frag|user/);
  });

  it("does not echo text that is not a URL", () => {
    expect(urlForLog("not a url with secret")).toBe("<invalid-url>");
  });
});
