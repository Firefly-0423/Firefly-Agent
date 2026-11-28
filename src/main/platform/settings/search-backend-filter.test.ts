import { describe, it, expect } from "vitest";
import { validateSearchApiKey as validate, filterToolsBySearchBackend as filter, shouldExposeSearchTool as visible, type SearchBackend } from "./search-backend-filter";

describe("Search credential validation", () => {
  it("accepts printable ASCII, normalizes surrounding spaces, and reports only metadata", () => {
    const key = "key-agenda-private84";
    const plain = validate(key, "Search credential");
    expect(plain.valid).toEqual(true);
    expect(plain.normalized).toEqual(key);
    expect(plain.diagnostics.hasNonAscii).toEqual(false);
    expect(plain.diagnostics.hasControlChars).toEqual(false);
    expect(plain.diagnostics.length).toEqual(20);
    expect(JSON.stringify(plain.diagnostics)).not.toContain(key);
    const padded = validate("  key-84  ", "Search credential");
    expect(padded.valid).toEqual(true);
    expect(padded.normalized).toEqual("key-84");
    expect(padded.diagnostics.trimmed).toEqual(true);
    expect(validate("  xyz  ", "Search credential").diagnostics.length).toEqual(3);
  });

  it.each(["", "    "])("rejects an empty normalized credential %j", (raw) => {
    const result = validate(raw, "Search credential");
    expect(result.valid).toEqual(false);
    expect(result.error).toContain("不能为空");
    if (raw.length) expect(result.diagnostics.trimmed).toEqual(true);
  });

  it.each(["key-测试84", "key-\u201C84"])("rejects non-ASCII input %j", (raw) => {
    const result = validate(raw, "Search credential");
    expect(result.valid).toEqual(false);
    expect(result.diagnostics.hasNonAscii).toEqual(true);
    expect(result.error).toContain("非 ASCII");
  });

  it.each(["key-\0agenda", "key-\nagenda", "key-\tagenda"])("rejects embedded control characters %j", (raw) => {
    const result = validate(raw, "Search credential");
    expect(result.valid).toEqual(false);
    expect(result.diagnostics.hasControlChars).toEqual(true);
    expect(result.error).toContain("控制字符");
  });
});

describe("Mutually exclusive search exposure", () => {
  const inventory = ["calendar_read", "web_search", "minimax-web-search-web_search", "agenda_export"].map((id) => ({ id }));
  it.each<[SearchBackend, string[]]>([
    ["off", ["calendar_read", "agenda_export"]],
    ["tavily", ["calendar_read", "web_search", "agenda_export"]],
    ["bocha", ["calendar_read", "web_search", "agenda_export"]],
    ["minimax", ["calendar_read", "minimax-web-search-web_search", "agenda_export"]],
  ])("keeps the complete ordered inventory for backend %s", (backend, expected) => {
    expect(filter(inventory, backend).map(({ id }) => id)).toStrictEqual(expected);
    expect(visible("web_search", backend)).toEqual(backend === "bocha" || backend === "tavily");
    expect(visible("minimax-web-search-web_search", backend)).toEqual(backend === "minimax");
    expect(visible("calendar_read", backend)).toEqual(true);
  });

  it("removes obsolete MCP search registrations and handles an empty inventory", () => {
    expect(filter(inventory.slice(1, 3), "bocha").map(({ id }) => id)).toEqual(["web_search"]);
    expect(filter([], "bocha")).toStrictEqual([]);
    expect(visible("weather", "off")).toEqual(true);
    expect(visible("music_search", "minimax")).toEqual(true);
    expect(visible("file_create", "bocha")).toEqual(true);
  });
});
