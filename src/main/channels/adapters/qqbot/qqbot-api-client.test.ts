import { afterEach, describe, expect, it, vi } from "vitest";
import { QqBotApiClient, QqBotApiError, type QqBotFetch } from "./qqbot-api-client";

const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const API_BASE = "https://api.sgroup.qq.com";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

function fetchMock(...responses: Array<Response | Error | (() => Response | Promise<Response>)>): QqBotFetch {
  let index = 0;
  return vi.fn(async () => {
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next();
    return next;
  }) as QqBotFetch;
}

type FetchCall = [string, RequestInit | undefined];

function calls(fn: QqBotFetch): FetchCall[] {
  return (fn as unknown as { mock: { calls: FetchCall[] } }).mock.calls;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("access token lifecycle", () => {
  it("posts the app credentials and caches the token", async () => {
    const fetchFn = fetchMock(json({ access_token: "token-1", expires_in: "7200" }));
    const client = new QqBotApiClient({ appId: "app", clientSecret: "secret" }, fetchFn);

    await expect(client.getAccessToken()).resolves.toBe("token-1");
    await expect(client.getAccessToken()).resolves.toBe("token-1");

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = calls(fetchFn)[0];
    expect(url).toBe(TOKEN_URL);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({ appId: "app", clientSecret: "secret" });
  });

  it("refreshes only when the cached token is inside the five-minute margin", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const fetchFn = fetchMock(
      json({ access_token: "first", expires_in: 7200 }),
      json({ access_token: "second", expires_in: 7200 }),
    );
    const client = new QqBotApiClient({ appId: "app", clientSecret: "secret" }, fetchFn);

    expect(await client.getAccessToken()).toBe("first");
    vi.setSystemTime(new Date("2026-01-01T01:54:59.999Z")); // 5m00.001s before expiry
    expect(await client.getAccessToken()).toBe("first");
    expect(fetchFn).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-01-01T01:55:00.000Z")); // exactly at the margin
    expect(await client.getAccessToken()).toBe("second");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent refreshes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchFn = vi.fn(async () => {
      await gate;
      return json({ access_token: "shared", expires_in: 7200 });
    }) as QqBotFetch;
    const client = new QqBotApiClient({ appId: "app", clientSecret: "secret" }, fetchFn);

    const first = client.getAccessToken();
    const second = client.getAccessToken();
    const third = client.getAccessToken();
    release();

    await expect(Promise.all([first, second, third])).resolves.toEqual(["shared", "shared", "shared"]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("defaults a missing or non-numeric expires_in to two hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const fetchFn = fetchMock(
      json({ access_token: "a", expires_in: "soon" }),
      json({ access_token: "b" }),
      json({ access_token: "c" }),
    );
    const client = new QqBotApiClient({ appId: "app", clientSecret: "secret" }, fetchFn);

    expect(await client.getAccessToken()).toBe("a");
    vi.setSystemTime(new Date("2026-01-01T01:54:59.000Z"));
    expect(await client.getAccessToken()).toBe("a");
    vi.setSystemTime(new Date("2026-01-01T01:55:00.000Z"));
    expect(await client.getAccessToken()).toBe("b");
    vi.setSystemTime(new Date("2026-01-01T03:50:00.000Z"));
    expect(await client.getAccessToken()).toBe("c");
  });

  it("surfaces an HTTP failure with its status", async () => {
    const fetchFn = fetchMock(text("nope", 500));
    const client = new QqBotApiClient({ appId: "app", clientSecret: "secret" }, fetchFn);

    const error = await client.getAccessToken().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(QqBotApiError);
    expect((error as QqBotApiError).name).toBe("QqBotApiError");
    expect((error as QqBotApiError).message).toBe("获取 access_token 失败 (HTTP 500)");
    expect((error as QqBotApiError).status).toBe(500);
  });

  it("rejects a response without access_token", async () => {
    const client = new QqBotApiClient(
      { appId: "app", clientSecret: "secret" },
      fetchMock(json({ expires_in: 7200 })),
    );
    await expect(client.getAccessToken()).rejects.toThrow("access_token 响应缺少 access_token");
  });

  it("retries a failed token request on the next call", async () => {
    const fetchFn = fetchMock(
      new Error("network down"),
      json({ access_token: "recovered", expires_in: 7200 }),
    );
    const client = new QqBotApiClient({ appId: "app", clientSecret: "secret" }, fetchFn);

    await expect(client.getAccessToken()).rejects.toThrow("network down");
    await expect(client.getAccessToken()).resolves.toBe("recovered");
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("getGatewayUrl", () => {
  it("reads the gateway URL with the QQBot authorization header", async () => {
    const fetchFn = fetchMock(
      json({ access_token: "token-1", expires_in: 7200 }),
      json({ url: "wss://api.sgroup.qq.com/websocket" }),
    );
    const client = new QqBotApiClient({ appId: "app", clientSecret: "secret" }, fetchFn);

    await expect(client.getGatewayUrl()).resolves.toBe("wss://api.sgroup.qq.com/websocket");
    const [url, init] = calls(fetchFn)[1];
    expect(url).toBe(`${API_BASE}/gateway`);
    expect(init?.headers).toMatchObject({ Authorization: "QQBot token-1" });
  });

  it("rejects a gateway response without a URL", async () => {
    const client = new QqBotApiClient(
      { appId: "app", clientSecret: "secret" },
      fetchMock(json({ access_token: "token-1", expires_in: 7200 }), json({})),
    );
    await expect(client.getGatewayUrl()).rejects.toThrow("gateway 响应缺少 url");
  });
});

describe("sendText", () => {
  it("posts a passive group reply with the encoded group openid and message fields", async () => {
    const fetchFn = fetchMock(
      json({ access_token: "token-1", expires_in: 7200 }),
      new Response(null, { status: 204 }),
    );
    const client = new QqBotApiClient({ appId: "app", clientSecret: "secret" }, fetchFn);

    await expect(
      client.sendText({ openid: "group/openid", chatType: "group" }, "hello", { msgId: "m-1", msgSeq: 2 }),
    ).resolves.toBeUndefined();

    const [url, init] = calls(fetchFn)[1];
    expect(url).toBe(`${API_BASE}/v2/groups/group%2Fopenid/messages`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      msg_type: 0,
      content: "hello",
      msg_id: "m-1",
      msg_seq: 2,
    });
  });

  it("posts a private reply to the users endpoint", async () => {
    const fetchFn = fetchMock(
      json({ access_token: "token-1", expires_in: 7200 }),
      json({ id: "message-id" }),
    );
    const client = new QqBotApiClient({ appId: "app", clientSecret: "secret" }, fetchFn);

    await client.sendText({ openid: "user-1", chatType: "private" }, "hi", { msgId: "m-2", msgSeq: 1 });

    const [url, init] = calls(fetchFn)[1];
    expect(url).toBe(`${API_BASE}/v2/users/user-1/messages`);
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "QQBot token-1",
    });
  });

  it("includes a JSON error detail and code when the body is JSON", async () => {
    const client = new QqBotApiClient(
      { appId: "app", clientSecret: "secret" },
      fetchMock(
        json({ access_token: "token-1", expires_in: 7200 }),
        json({ code: 40034, message: "invalid msg_id" }, 400),
      ),
    );

    const error = await client
      .sendText({ openid: "u", chatType: "private" }, "x", { msgId: "bad", msgSeq: 1 })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(QqBotApiError);
    expect((error as QqBotApiError).status).toBe(400);
    expect((error as QqBotApiError).message).toBe(
      "QQ Bot API /v2/users/u/messages 失败 (HTTP 400) invalid msg_id (code 40034)",
    );
  });

  it("falls back to a plain error when the error body is not JSON", async () => {
    const client = new QqBotApiClient(
      { appId: "app", clientSecret: "secret" },
      fetchMock(
        json({ access_token: "token-1", expires_in: 7200 }),
        text("<html>bad gateway</html>", 502),
      ),
    );

    await expect(
      client.sendText({ openid: "u", chatType: "private" }, "x", { msgId: "m", msgSeq: 1 }),
    ).rejects.toThrow("QQ Bot API /v2/users/u/messages 失败 (HTTP 502)");
  });

  it("accepts an empty successful response body", async () => {
    const client = new QqBotApiClient(
      { appId: "app", clientSecret: "secret" },
      fetchMock(
        json({ access_token: "token-1", expires_in: 7200 }),
        new Response("", { status: 200 }),
      ),
    );
    await expect(
      client.sendText({ openid: "u", chatType: "private" }, "x", { msgId: "m", msgSeq: 1 }),
    ).resolves.toBeUndefined();
  });
});
