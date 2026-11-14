import { describe, expect, it } from "vitest";
import { urlForLog } from "./url-for-log";

describe("urlForLog", () => {
  it("keeps protocol, host and path", () => {
    expect(urlForLog("https://example.com/a/b.png")).toBe("https://example.com/a/b.png");
  });

  it("drops credentials, query values and fragments", () => {
    const logged = urlForLog("https://user:secret@example.com:8443/file?token=abc&x=1#frag");
    expect(logged).toBe("https://example.com:8443/file?<query>");
    expect(logged).not.toMatch(/secret|abc|frag|user/);
  });

  it("does not echo text that is not a URL", () => {
    expect(urlForLog("not a url with secret")).toBe("<invalid-url>");
  });
});
