import { afterEach, expect, it, vi } from "vitest";
import { resolveOverHttps } from "./browser-doh";

afterEach(() => { vi.unstubAllGlobals(); });
const reply = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;

it("asks for A and AAAA by name and keeps only well-formed address records", async () => {
  const fetch = vi.fn(async (url: string) => reply(url.includes("type=1")
    ? { Status: 0, Answer: [{ type: 5, data: "edge.example.net." }, { type: 1, data: "104.20.23.154" }, { type: 1, data: "not-an-ip" }, { type: 28, data: "104.20.23.155" }] }
    : { Status: 0, Answer: [{ type: 28, data: "2606:4700::6812:179a" }] }));
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  expect(await resolveOverHttps("example.com", signal)).toEqual([{ address: "104.20.23.154", family: 4 }, { address: "2606:4700::6812:179a", family: 6 }]);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(["https://dns.alidns.com/resolve?name=example.com&type=1", "https://dns.alidns.com/resolve?name=example.com&type=28"]);
  expect(fetch.mock.calls.every(([, init]) => (init as RequestInit).signal === signal)).toBe(true);
});

it("treats NXDOMAIN as no answer and fails on an HTTP or DNS error", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => reply({ Status: 3 })));
  expect(await resolveOverHttps("missing.example", new AbortController().signal)).toEqual([]);
  vi.stubGlobal("fetch", vi.fn(async () => reply({}, false)));
  await expect(resolveOverHttps("example.com", new AbortController().signal)).rejects.toMatchObject({ code: "EDOH" });
  vi.stubGlobal("fetch", vi.fn(async () => reply({ Status: 2 })));
  await expect(resolveOverHttps("example.com", new AbortController().signal)).rejects.toMatchObject({ code: "EDOH" });
});
