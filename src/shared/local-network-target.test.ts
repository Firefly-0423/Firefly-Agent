import { describe, expect, it } from "vitest";
import { localAuthorityFromUrl, manualBrowserTarget, normalizeTypedAddress, resolveAddressInput, parseLocalAuthority, parseLocalBrowserUrl, sameLocalHost } from "./local-network-target";

describe("private-network browser targets", () => {
  it.each([
    ["http://localhost:5173/app", "localhost:5173"],
    ["http://localhost/", "localhost:80"],
    ["https://localhost/", "localhost:443"],
    ["http://127.0.0.1:3000", "127.0.0.1:3000"],
    ["http://[::1]:8080/x", "[::1]:8080"],
    ["http://10.1.2.3/", "10.1.2.3:80"],
    ["http://172.16.0.9:9000", "172.16.0.9:9000"],
    ["http://172.31.255.254:1", "172.31.255.254:1"],
    ["http://192.168.1.5:8080", "192.168.1.5:8080"],
    ["http://0x7f.1:8080/", "127.0.0.1:8080"], // the URL parser canonicalizes this spelling
  ])("accepts %s", (url, key) => {
    expect(parseLocalBrowserUrl(url)?.key).toBe(key);
    expect(manualBrowserTarget(url)).toMatchObject({ network: "local", key });
  });

  it.each([
    "http://169.254.169.254/latest/meta-data", // link-local metadata endpoint
    "http://100.64.0.1/", "http://0.0.0.0:80/", "http://224.0.0.1/", "http://255.255.255.255/",
    "http://172.15.0.1/", "http://172.32.0.1/", "http://192.169.0.1/", "http://11.0.0.1/",
    "http://localhost.evil.com/", "http://127.0.0.1.nip.io/", "http://foo.localhost/", "http://localhost./",
    "http://nas.local/", "http://intranet.corp/", "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/", "http://[fe80::1]/",
    "http://user@localhost:3000/", "http://user:pw@192.168.1.5/", "http://localhost:0/", "http://localhost:65536/",
    "ftp://localhost/", "file:///C:/x", "javascript:alert(1)", "data:text/html,x", "ws://localhost:5173/", "",
  ])("rejects %s", url => {
    expect(parseLocalBrowserUrl(url)).toBeNull();
    expect(manualBrowserTarget(url)).toBeNull();
  });

  it("keeps public classification exactly as before", () => {
    expect(manualBrowserTarget("https://example.com/path")).toMatchObject({ network: "public", key: "example.com" });
    expect(manualBrowserTarget("https://example.com:443/")).toMatchObject({ network: "public", key: "example.com" });
    for (const url of ["http://example.com/", "https://example.com:8443/", "https://u:p@example.com/", "https://", "example.com"]) {
      expect(manualBrowserTarget(url)).toBeNull();
    }
  });

  it("canonicalizes grant keys and refuses anything else", () => {
    expect(parseLocalAuthority("localhost:5173")).toEqual({ host: "localhost", port: 5173 });
    expect(parseLocalAuthority("[::1]:80")).toEqual({ host: "[::1]", port: 80 });
    for (const value of ["localhost", "localhost:05173", "localhost:0", "localhost:70000", "LOCALHOST:80", "169.254.1.1:80", "192.168.01.1:80",
      "192.168.1.5:80/x", "evil.com:80", "http://localhost:80", 80, null, undefined, "x".repeat(100)]) expect(parseLocalAuthority(value)).toBeNull();
  });

  it("recognizes socket schemes for same-host dev-server traffic only", () => {
    expect(localAuthorityFromUrl(new URL("ws://localhost:5173/"))).toBe("localhost:5173");
    expect(localAuthorityFromUrl(new URL("wss://192.168.1.5/"))).toBe("192.168.1.5:443");
    expect(localAuthorityFromUrl(new URL("ws://example.com/"))).toBeNull();
    expect(sameLocalHost("localhost:5173", "localhost:3000")).toBe(true);
    expect(sameLocalHost("localhost:5173", "127.0.0.1:5173")).toBe(false);
    expect(sameLocalHost("localhost:5173", "example.com:80")).toBe(false);
  });

  it("turns address-bar text into a private authority, a bare public host, an explicit URL or a search", () => {
    const search = (q: string) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`;
    expect(resolveAddressInput("localhost:5173")).toBe("http://localhost:5173");
    expect(resolveAddressInput("example.com")).toBe("https://example.com");
    expect(resolveAddressInput(" docs.example.org/a/b?c=d#e ")).toBe("https://docs.example.org/a/b?c=d#e");
    expect(resolveAddressInput("8.8.8.8")).toBe("https://8.8.8.8");
    expect(resolveAddressInput("192.168.1.5:3000")).toBe("http://192.168.1.5:3000");
    expect(resolveAddressInput("https://example.com/x")).toBe("https://example.com/x");
    expect(resolveAddressInput("example.com:8443")).toBe("https://example.com:8443"); // classified and refused later
    for (const refused of ["http://example.com/", "file:///C:/x", "javascript:alert(1)", "data:text/html,x", "ftp://example.com/", "ws://localhost:5173/"]) {
      expect(resolveAddressInput(refused)).toBe(refused);
      expect(manualBrowserTarget(refused)).toBeNull();
    }
    expect(resolveAddressInput("hello world")).toBe(search("hello world"));
    expect(resolveAddressInput("天气 北京")).toBe(search("天气 北京"));
    expect(resolveAddressInput("hello")).toBe(search("hello"));
    expect(resolveAddressInput("a&b=c d")).toBe(search("a&b=c d"));
    expect(resolveAddressInput("foo@bar.com")).toBe(search("foo@bar.com"));
    expect(resolveAddressInput("")).toBe("");
    expect(manualBrowserTarget(resolveAddressInput("hello world"))).toMatchObject({ network: "public", key: "www.bing.com" });
  });

  it("adds http:// only to scheme-less private-network input", () => {
    expect(normalizeTypedAddress("localhost:5173")).toBe("http://localhost:5173");
    expect(normalizeTypedAddress("  192.168.1.5:3000/app ")).toBe("http://192.168.1.5:3000/app");
    expect(normalizeTypedAddress("[::1]:8080")).toBe("http://[::1]:8080");
    expect(normalizeTypedAddress("localhost")).toBe("http://localhost");
    expect(normalizeTypedAddress("https://localhost:5173")).toBe("https://localhost:5173");
    expect(normalizeTypedAddress("example.com")).toBe("example.com");
    expect(normalizeTypedAddress("localhost.evil.com")).toBe("localhost.evil.com");
    expect(normalizeTypedAddress("localhost@evil.com")).toBe("localhost@evil.com");
  });
});
