import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  writeFile: vi.fn(),
}));
const osMock = vi.hoisted(() => ({ home: "" }));
const ephemeralMock = vi.hoisted(() => ({ any: vi.fn(() => false) }));

vi.mock("fs", () => fsMock);
vi.mock("os", () => ({ homedir: () => osMock.home }));
vi.mock("../../ephemeral-conversations", () => ({
  ephemeralConversations: ephemeralMock,
}));

type WriteCallback = (error: Error | null) => void;

const request = {
  transport: "openai" as const,
  endpoint: "https://example.test/v1/chat/completions",
  body: { model: "demo", messages: [{ role: "user", content: "hi" }] },
};

const response = {
  transport: "anthropic" as const,
  ok: true,
  text: "visible answer",
  thinking: "private reasoning",
  toolCalls: [{ id: "call-1" }],
  usage: { input_tokens: 3 },
  raw: { id: "msg-1" },
};

function dayFolder(): string {
  return path.join(osMock.home, ".firefly", "prompt-dumps", "20260817");
}

async function loadModule(): Promise<typeof import("./prompt-dump")> {
  vi.resetModules();
  return import("./prompt-dump");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 7, 17, 15, 30, 45, 123));
  osMock.home = path.join("C:\\", "synthetic-home");
  ephemeralMock.any.mockReset().mockReturnValue(false);
  fsMock.mkdirSync.mockReset().mockReturnValue(undefined);
  fsMock.writeFile.mockReset().mockImplementation((_target, _data, callback: WriteCallback) => {
    callback(null);
  });
  delete process.env.FIREFLY_PROMPT_DUMP;
});

afterEach(() => {
  delete process.env.FIREFLY_PROMPT_DUMP;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("dumpRequest policy and failure handling", () => {
  it("returns null without allocating a trace when diagnostics persistence is refused", async () => {
    process.env.FIREFLY_PROMPT_DUMP = "1";
    const { dumpRequest } = await loadModule();

    expect(dumpRequest(request, false)).toBeNull();
    expect(fsMock.mkdirSync).not.toHaveBeenCalled();
    expect(fsMock.writeFile).not.toHaveBeenCalled();

    // The refused request must not consume a sequence number.
    expect(dumpRequest(request)).toBe("153045-123_openai_001");
  });

  it("returns a trace id but writes nothing while dumping is disabled", async () => {
    const { dumpRequest } = await loadModule();

    expect(dumpRequest(request)).toBe("153045-123_openai_001");
    expect(dumpRequest({ ...request, transport: "responses" })).toBe(
      "153045-123_responses_002",
    );
    expect(fsMock.mkdirSync).not.toHaveBeenCalled();
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("only accepts the exact env value 1", async () => {
    process.env.FIREFLY_PROMPT_DUMP = "true";
    const { dumpRequest } = await loadModule();
    expect(dumpRequest(request)).toBe("153045-123_openai_001");
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("writes a structured request payload under the day folder when enabled", async () => {
    process.env.FIREFLY_PROMPT_DUMP = "1";
    const { dumpRequest } = await loadModule();

    const traceId = dumpRequest(request);

    expect(traceId).toBe("153045-123_openai_001");
    expect(fsMock.mkdirSync).toHaveBeenCalledWith(dayFolder(), { recursive: true });
    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
    const [target, data] = fsMock.writeFile.mock.calls[0] as [string, string, WriteCallback];
    expect(target).toBe(path.join(dayFolder(), `${traceId}_req.json`));
    expect(JSON.parse(data)).toMatchObject({
      traceId,
      phase: "request",
      transport: "openai",
      endpoint: request.endpoint,
      body: request.body,
    });
    expect(typeof JSON.parse(data).ts).toBe("string");
  });

  it("still returns the trace id when creating the folder fails", async () => {
    process.env.FIREFLY_PROMPT_DUMP = "1";
    fsMock.mkdirSync.mockImplementation(() => {
      throw new Error("synthetic denied");
    });
    const { dumpRequest } = await loadModule();

    expect(dumpRequest(request)).toBe("153045-123_openai_001");
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("swallows synchronous and asynchronous write failures", async () => {
    process.env.FIREFLY_PROMPT_DUMP = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fsMock.writeFile.mockImplementation(() => {
      throw new Error("synthetic queue failure");
    });
    const { dumpRequest } = await loadModule();

    expect(() => dumpRequest(request)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("queue failed"),
      "synthetic queue failure",
    );

    fsMock.writeFile.mockReset().mockImplementation((_target, _data, callback: WriteCallback) => {
      callback(new Error("synthetic disk full"));
    });
    expect(() => dumpRequest(request)).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("write failed"),
      "synthetic disk full",
    );
  });

  it("disables dumping once a temporary conversation exists, without caching that refusal", async () => {
    process.env.FIREFLY_PROMPT_DUMP = "1";
    ephemeralMock.any.mockReturnValue(true);
    const { dumpRequest } = await loadModule();

    expect(dumpRequest(request)).toBe("153045-123_openai_001");
    expect(fsMock.writeFile).not.toHaveBeenCalled();

    ephemeralMock.any.mockReturnValue(false);
    expect(dumpRequest(request)).toBe("153045-123_openai_002");
    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
  });

  it("caches the env decision for the module lifetime", async () => {
    const { dumpRequest } = await loadModule();
    expect(dumpRequest(request)).toBe("153045-123_openai_001");
    process.env.FIREFLY_PROMPT_DUMP = "1";
    expect(dumpRequest(request)).toBe("153045-123_openai_002");
    expect(fsMock.writeFile).not.toHaveBeenCalled();

    vi.resetModules();
    const reloaded = await import("./prompt-dump");
    expect(reloaded.dumpRequest(request)).toBe("153045-123_openai_001");
    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
  });
});

describe("dumpResponse payloads and guards", () => {
  it("does nothing for a null trace id", async () => {
    process.env.FIREFLY_PROMPT_DUMP = "1";
    const { dumpResponse } = await loadModule();

    dumpResponse(null, response);

    expect(fsMock.mkdirSync).not.toHaveBeenCalled();
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("does nothing while dumping is disabled", async () => {
    const { dumpResponse } = await loadModule();
    dumpResponse("trace-1", response);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it("writes the extracted and raw response payload when enabled", async () => {
    process.env.FIREFLY_PROMPT_DUMP = "1";
    const { dumpResponse } = await loadModule();

    dumpResponse("trace-1", response);

    expect(fsMock.mkdirSync).toHaveBeenCalledWith(dayFolder(), { recursive: true });
    const [target, data] = fsMock.writeFile.mock.calls[0] as [string, string, WriteCallback];
    expect(target).toBe(path.join(dayFolder(), "trace-1_res.json"));
    expect(JSON.parse(data)).toEqual({
      traceId: "trace-1",
      ts: new Date().toISOString(),
      phase: "response",
      transport: "anthropic",
      ok: true,
      text: "visible answer",
      thinking: "private reasoning",
      toolCalls: [{ id: "call-1" }],
      usage: { input_tokens: 3 },
      raw: { id: "msg-1" },
    });
  });

  it("includes error details for failed responses", async () => {
    process.env.FIREFLY_PROMPT_DUMP = "1";
    const { dumpResponse } = await loadModule();

    dumpResponse("trace-2", { transport: "openai", ok: false, raw: null, error: "rate limited" });

    const [, data] = fsMock.writeFile.mock.calls[0] as [string, string, WriteCallback];
    expect(JSON.parse(data)).toMatchObject({
      traceId: "trace-2",
      ok: false,
      raw: null,
      error: "rate limited",
    });
  });

  it("stops when the folder cannot be created or a temporary conversation exists", async () => {
    process.env.FIREFLY_PROMPT_DUMP = "1";
    fsMock.mkdirSync.mockImplementation(() => {
      throw new Error("synthetic denied");
    });
    const { dumpResponse } = await loadModule();
    dumpResponse("trace-1", response);
    expect(fsMock.writeFile).not.toHaveBeenCalled();

    fsMock.mkdirSync.mockReturnValue(undefined);
    ephemeralMock.any.mockReturnValue(true);
    dumpResponse("trace-1", response);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });
});
