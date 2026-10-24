import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const marked: string[] = [];
let ephemeralConversations: typeof import("../../ephemeral-conversations").ephemeralConversations;
let home: string;

async function loadDump() {
  vi.resetModules();
  // The dump module and the test must share one registry instance.
  ({ ephemeralConversations } = await import("../../ephemeral-conversations"));
  return import("./prompt-dump");
}
const dumped = () => {
  const root = path.join(home, ".firefly", "prompt-dumps");
  return fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).filter((name) => String(name).endsWith(".json")) : [];
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

const savedHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-dump-"));
  // os.homedir() reads these; the dump root is resolved when the module loads.
  process.env.HOME = home; process.env.USERPROFILE = home;
  process.env.FIREFLY_PROMPT_DUMP = "1";
});
afterEach(() => {
  delete process.env.FIREFLY_PROMPT_DUMP;
  for (const [key, value] of Object.entries(savedHome)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  for (const id of marked.splice(0)) ephemeralConversations?.release(id);
  vi.restoreAllMocks();
  fs.rmSync(home, { recursive: true, force: true });
});

const request = { transport: "openai" as const, endpoint: "https://example.test", body: { messages: [{ role: "user", content: "secret question" }] } };
const response = { transport: "openai" as const, ok: true, text: "secret answer", raw: {} };

describe("prompt dump and temporary chats", () => {
  it("still writes request and response when the flag is on and no temporary chat exists", async () => {
    const { dumpRequest, dumpResponse } = await loadDump();
    dumpResponse(dumpRequest(request), response);
    await settle();
    expect(dumped()).toHaveLength(2);
  });

  it("writes nothing once a temporary chat exists, even for the response of an earlier request", async () => {
    const { dumpRequest, dumpResponse } = await loadDump();
    const traceId = dumpRequest(request);
    await settle();
    const before = dumped().length;
    const id = "temporary-chat-1"; marked.push(id); ephemeralConversations.mark(id);
    dumpResponse(traceId, response);
    dumpResponse(dumpRequest(request), response);
    await settle();
    expect(dumped()).toHaveLength(before);
  });

  it("still returns a trace id so callers can correlate logs", async () => {
    const { dumpRequest } = await loadDump();
    const id = "temporary-chat-2"; marked.push(id); ephemeralConversations.mark(id);
    expect(dumpRequest(request)).toMatch(/_openai_/);
  });
});
