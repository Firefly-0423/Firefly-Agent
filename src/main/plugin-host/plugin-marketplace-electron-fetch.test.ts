import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { electronMarketFetch } from "./plugin-marketplace";

type FakeRequest = EventEmitter & { options: Record<string, unknown>; abort: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
const requests: FakeRequest[] = [];
// Stands in for Electron's net.request: each call records a request the test drives by emitting its events.
const createRequest = ((options: Record<string, unknown>) => {
  const request = Object.assign(new EventEmitter(), { options, abort: vi.fn(), end: vi.fn() }) as FakeRequest;
  requests.push(request);
  return request;
}) as unknown as Parameters<typeof electronMarketFetch>[2];


function incoming(statusCode: number, headers: Record<string, string | string[]>) {
  return Object.assign(new EventEmitter(), { statusCode, headers });
}

describe("electronMarketFetch", () => {
  beforeEach(() => { requests.length = 0; });

  it("asks for manual redirects without cookies or credentials", async () => {
    void electronMarketFetch("https://github.com/o/r/releases/download/a/a.zip", undefined, createRequest);
    expect(requests[0].options).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit", useSessionCookies: false });
    expect(requests[0].end).toHaveBeenCalled();
  });

  it("hands a redirect back as a bodiless 3xx so the caller decides whether to follow it", async () => {
    const pending = electronMarketFetch("https://github.com/o/r/releases/download/a/a.zip", undefined, createRequest);
    requests[0].emit("redirect", 302, "GET", "https://release-assets.githubusercontent.com/x", {});
    const response = await pending;
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://release-assets.githubusercontent.com/x");
    expect(requests[0].abort).toHaveBeenCalled();
  });

  it("streams the body of a final response with its headers", async () => {
    const pending = electronMarketFetch("https://release-assets.githubusercontent.com/x", undefined, createRequest);
    const message = incoming(200, { "content-type": "application/zip", "set-cookie": ["a=1", "b=2"] });
    requests[0].emit("response", message);
    const response = await pending;
    message.emit("data", Buffer.from("PK"));
    message.emit("data", Buffer.from("zip"));
    message.emit("end");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(new TextDecoder().decode(await response.arrayBuffer())).toBe("PKzip");
  });

  it("rejects on a network error and when the caller aborts", async () => {
    const failing = electronMarketFetch("https://github.com/x", undefined, createRequest);
    requests[0].emit("error", new Error("net::ERR_CONNECTION_RESET"));
    await expect(failing).rejects.toThrow("ERR_CONNECTION_RESET");

    const controller = new AbortController();
    const cancelled = electronMarketFetch("https://github.com/y", { signal: controller.signal }, createRequest);
    controller.abort();
    await expect(cancelled).rejects.toThrow();
    expect(requests[1].abort).toHaveBeenCalled();
  });
});
