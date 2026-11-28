import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lookup } from "node:dns/promises";
import { readResponseBytes, withPublicResponse } from "./network-guard";

const transport = vi.hoisted(() => ({ lookups: [] as Function[], destroy: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("undici", () => ({
  Agent: class {
    constructor(options: { connect: { lookup: Function } }) { transport.lookups.push(options.connect.lookup); }
    destroy() { transport.destroy(); return Promise.resolve(); }
  },
}));

const publicAnswer = [{ address: "93.184.216.34", family: 4 }];
const init = () => ({ signal: new AbortController().signal, headers: { Accept: "text/plain" } });
const read = (url: string) => withPublicResponse(url, init(), (response) => response.text());

beforeEach(() => {
  vi.mocked(lookup).mockReset().mockResolvedValue(publicAnswer);
  transport.lookups.length = 0;
  transport.destroy.mockClear();
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response("public content")));
});
afterEach(() => vi.unstubAllGlobals());

describe("public-network GET guard", () => {
  it.each([
    "http://127.0.0.1/", "http://127.1/", "http://0x7f000001/", "http://2130706433/",
    "http://0.0.0.0/", "http://10.1.2.3/", "http://172.16.0.1/", "http://192.168.1.1/",
    "http://169.254.169.254/", "http://100.100.100.200/", "http://168.63.129.16/",
    "http://[::1]/", "http://[::]/", "http://[fe80::1]/", "http://[fc00::1]/",
    "http://[fd00:ec2::254]/", "http://[::ffff:127.0.0.1]/", "http://[2002:7f00:1::]/",
  ])("blocks non-public and alternate-form IP URL %s without a request", async (url) => {
    await expect(read(url)).rejects.toThrow("non-public");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["127.0.0.1", "10.0.0.1", "172.31.0.1", "192.168.0.1", "169.254.169.254", "::1", "fd00::1", "fe80::1"])(
    "rejects DNS answer %s even alongside a public answer", async (address) => {
      vi.mocked(lookup).mockResolvedValue([...publicAnswer, { address, family: address.includes(":") ? 6 : 4 }]);
      await expect(read("https://docs.example/page")).rejects.toThrow("non-public");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("pins a DNS snapshot in the connector and retains the original hostname", async () => {
    vi.mocked(lookup).mockResolvedValueOnce(publicAnswer).mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(read("https://docs.example/page")).resolves.toBe("public content");
    expect(lookup).toHaveBeenCalledTimes(1);
    const single = vi.fn();
    const all = vi.fn();
    transport.lookups[0]("docs.example", {}, single);
    transport.lookups[0]("docs.example", { all: true }, all);
    expect(single).toHaveBeenCalledWith(null, "93.184.216.34", 4);
    expect(all).toHaveBeenCalledWith(null, publicAnswer);
    expect(fetch).toHaveBeenCalledWith("https://docs.example/page", expect.objectContaining({ redirect: "manual", dispatcher: expect.anything() }));
    expect(transport.destroy).toHaveBeenCalledOnce();
  });

  it.each(["http://8.8.8.8/", "https://[2606:4700:4700::1111]/"])("permits public literal %s", async (url) => {
    await expect(read(url)).resolves.toBe("public content");
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(["ftp://example.com/a", "file:///etc/passwd", "https://user:secret@example.com/a"])("rejects unsupported URL %s", async (url) => {
    await expect(read(url)).rejects.toThrow("HTTP(S)");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("follows relative public redirects and cancels unused redirect bodies", async () => {
    const cancel = vi.fn();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), {
      status: 302, headers: { location: "/next" },
    }));
    await expect(read("https://docs.example/start")).resolves.toBe("public content");
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(2, "https://docs.example/next", expect.objectContaining({ redirect: "manual" }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(transport.destroy).toHaveBeenCalledTimes(2);
  });

  it.each([301, 302, 303, 307, 308])("blocks a status %s redirect to loopback before the next request", async (status) => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status, headers: { location: "http://127.0.0.1/secret" } }));
    await expect(read("https://docs.example/start")).rejects.toThrow("non-public");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("revalidates DNS on a same-host redirect (rebinding)", async () => {
    vi.mocked(lookup).mockResolvedValueOnce(publicAnswer).mockResolvedValueOnce([{ address: "192.168.1.1", family: 4 }]);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/internal" } }));
    await expect(read("https://docs.example/start")).rejects.toThrow("non-public");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("bounds a redirect loop to five hops", async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(null, { status: 302, headers: { location: "/loop" } }));
    await expect(read("https://docs.example/start")).rejects.toThrow("Too many redirects");
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(transport.destroy).toHaveBeenCalledTimes(6);
  });

  it("fails closed on empty or failed DNS", async () => {
    vi.mocked(lookup).mockResolvedValueOnce([]);
    await expect(read("https://docs.example/start")).rejects.toThrow("no addresses");
    vi.mocked(lookup).mockRejectedValueOnce(new Error("DNS unavailable"));
    await expect(read("https://docs.example/start")).rejects.toThrow("DNS unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("honors cancellation during DNS resolution", async () => {
    vi.mocked(lookup).mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const result = withPublicResponse("https://docs.example", { ...init(), signal: controller.signal }, async () => "unused");
    controller.abort(new Error("cancelled"));
    await expect(result).rejects.toThrow("cancelled");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels the body and destroys its dispatcher when the consumer rejects", async () => {
    const cancel = vi.fn();
    vi.mocked(fetch).mockResolvedValue(new Response(new ReadableStream({ cancel })));
    await expect(withPublicResponse("https://docs.example", init(), async () => { throw new Error("consumer failed"); })).rejects.toThrow("consumer failed");
    expect(cancel).toHaveBeenCalledOnce();
    expect(transport.destroy).toHaveBeenCalledOnce();
  });
});

describe("stream byte budget", () => {
  it("keeps a small exact-limit response intact", async () => {
    const result = await readResponseBytes(new Response("abcd"), 4, true);
    expect(result.bytes.toString()).toBe("abcd");
    expect(result.truncated).toBe(false);
  });

  it("preserves data across page boundaries and one-byte chunks", async () => {
    let count = 0;
    const response = new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array([count % 256]));
        if (++count === 65_539) controller.close();
      },
    }));
    const result = await readResponseBytes(response, 65_540);
    expect(result.truncated).toBe(false);
    expect(result.bytes).toEqual(Buffer.from(Array.from({ length: 65_539 }, (_, i) => i % 256)));
  });

  it("copies only the allowed bytes of an oversized chunk and cancels", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new TextEncoder().encode("abcdefgh")); }, cancel,
    }, { highWaterMark: 0 }));
    const result = await readResponseBytes(response, 4, true);
    expect(result.bytes.toString()).toBe("abcd");
    expect(result.truncated).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it("rejects an oversized binary response, cancels and releases its reader", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(5)); }, cancel,
    }, { highWaterMark: 0 }));
    await expect(readResponseBytes(response, 4)).rejects.toThrow("文件过大");
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });
});
