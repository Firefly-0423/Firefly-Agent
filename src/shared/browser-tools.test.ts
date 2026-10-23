import { describe, expect, it } from "vitest";
import { nextBrowserZoomPercent, normalizeBrowserCookieDomain, parseBrowserToolRequest } from "./browser-tools";

describe("parseBrowserToolRequest", () => {
  it("accepts each well-formed request", () => {
    expect(parseBrowserToolRequest({ tool: "state" })).toEqual({ tool: "state" });
    expect(parseBrowserToolRequest({ tool: "snapshot" })).toEqual({ tool: "snapshot" });
    expect(parseBrowserToolRequest({ tool: "find", text: "  hello ", forward: true, next: false })).toEqual({ tool: "find", text: "hello", forward: true, next: false });
    expect(parseBrowserToolRequest({ tool: "zoom", op: "in" })).toEqual({ tool: "zoom", op: "in" });
    expect(parseBrowserToolRequest({ tool: "device", preset: "phone" })).toEqual({ tool: "device", preset: "phone" });
    expect(parseBrowserToolRequest({ tool: "clear-data", kinds: ["cookies", "cookies", "cache"] })).toEqual({ tool: "clear-data", kinds: ["cookies", "cache"] });
    expect(parseBrowserToolRequest({ tool: "clear-data", kinds: ["cookies"], domain: ".Example.com" })).toEqual({ tool: "clear-data", kinds: ["cookies"], domain: "example.com" });
    expect(parseBrowserToolRequest({ tool: "download", op: "list" })).toEqual({ tool: "download", op: "list" });
    expect(parseBrowserToolRequest({ tool: "download", op: "open", id: "d1" })).toEqual({ tool: "download", op: "open", id: "d1" });
    expect(parseBrowserToolRequest({ tool: "settings", patch: { askWhereToSave: true } })).toEqual({ tool: "settings", patch: { askWhereToSave: true } });
    expect(parseBrowserToolRequest({ tool: "settings", chooseFolder: true })).toEqual({ tool: "settings", chooseFolder: true });
  });

  it.each([
    null, [], "find", {}, { tool: "eval" }, { tool: "state", extra: 1 },
    { tool: "find", text: "", forward: true, next: false }, { tool: "find", text: "x".repeat(201), forward: true, next: false },
    { tool: "find", text: "x", forward: "yes", next: false }, { tool: "find", text: "x", forward: true },
    { tool: "zoom", op: "max" }, { tool: "device", preset: "tv" },
    { tool: "clear-data", kinds: [] }, { tool: "clear-data", kinds: ["history"] }, { tool: "clear-data", kinds: ["cache"], domain: "example.com" },
    { tool: "clear-data", kinds: ["cookies"], domain: "https://example.com/" }, { tool: "clear-data", kinds: ["cookies"], domain: "a b" },
    { tool: "download", op: "open" }, { tool: "download", op: "list", id: "d1" }, { tool: "download", op: "remove", id: "" },
    { tool: "download", op: "format", id: "d1" },
    { tool: "settings", patch: { askWhereToSave: "yes" } }, { tool: "settings", patch: { directory: "C:/x" } },
    { tool: "settings", chooseFolder: false }, { tool: "settings", chooseFolder: true, resetFolder: true }, { tool: "settings", path: "C:/x" },
  ])("refuses %j", value => {
    expect(parseBrowserToolRequest(value)).toBeNull();
  });
});

describe("normalizeBrowserCookieDomain", () => {
  it("keeps plain host names only", () => {
    expect(normalizeBrowserCookieDomain("example.com")).toBe("example.com");
    expect(normalizeBrowserCookieDomain(".sub.Example.com")).toBe("sub.example.com");
    for (const bad of ["", ".", "a/b", "a:443", "*.example.com", "exa mple.com", "-a.com", "a..com", 5, undefined, "a".repeat(254)]) {
      expect(normalizeBrowserCookieDomain(bad), String(bad)).toBeNull();
    }
  });
});

describe("nextBrowserZoomPercent", () => {
  it("steps through the preset stops and clamps at both ends", () => {
    expect(nextBrowserZoomPercent(100, "in")).toBe(110);
    expect(nextBrowserZoomPercent(100, "out")).toBe(90);
    expect(nextBrowserZoomPercent(500, "in")).toBe(500);
    expect(nextBrowserZoomPercent(25, "out")).toBe(25);
    expect(nextBrowserZoomPercent(137, "in")).toBe(150);
    expect(nextBrowserZoomPercent(137, "out")).toBe(125);
    expect(nextBrowserZoomPercent(250, "reset")).toBe(100);
  });
});
