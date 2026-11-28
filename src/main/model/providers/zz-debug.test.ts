import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
  mkdirSync: vi.fn(),
  writeFile: vi.fn((_target: string, _data: string, callback: (error: Error | null) => void) => {
    callback(null);
  }),
}));
const osMock = vi.hoisted(() => ({ home: "" }));

vi.mock("fs", () => fsMock);
vi.mock("os", () => ({ homedir: () => osMock.home }));

async function loadModule(): Promise<typeof import("./prompt-dump")> {
  vi.resetModules();
  return import("./prompt-dump");
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 7, 17, 15, 30, 45, 123));
  osMock.home = path.join("C:\\", "synthetic-home");
  fsMock.mkdirSync.mockReset().mockReturnValue(undefined);
  fsMock.writeFile.mockClear();
  process.env.FIREFLY_PROMPT_DUMP = "1";
});

afterEach(() => {
  delete process.env.FIREFLY_PROMPT_DUMP;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("prompt dump request contract", () => {
  it("uses a stable timestamp/transport/sequence trace id and writes only when enabled", async () => {
    const { dumpRequest } = await loadModule();
    const request = { transport: "responses" as const, endpoint: "/v1/responses", body: { input: "hi" } };

    expect(dumpRequest(request)).toBe("153045-123_responses_001");
    expect(dumpRequest(request)).toBe("153045-123_responses_002");
    expect(fsMock.writeFile).toHaveBeenCalledTimes(2);
    expect(fsMock.mkdirSync).toHaveBeenCalledWith(
      path.join(osMock.home, ".firefly", "prompt-dumps", "20260817"),
      { recursive: true },
    );
  });
});
