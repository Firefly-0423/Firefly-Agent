import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ userData: "" }));
vi.mock("electron", () => ({ app: { getPath: () => mocks.userData } }));

import {
  appendApiLog,
  buildChatCompletionsUrl,
  getApiLogPath,
  normalizeChatMessages,
} from "./chat-api-utils";

let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-chat-api-"));
  mocks.userData = root;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("buildChatCompletionsUrl", () => {
  it("appends the chat completions path to a base URL", () => {
    expect(buildChatCompletionsUrl("https://api.example.com/v1")).toBe(
      "https://api.example.com/v1/chat/completions",
    );
  });

  it("trims whitespace and trailing slashes", () => {
    expect(buildChatCompletionsUrl("  https://api.example.com/v1///  ")).toBe(
      "https://api.example.com/v1/chat/completions",
    );
  });

  it("is idempotent when the URL already ends with the endpoint", () => {
    expect(buildChatCompletionsUrl("https://api.example.com/v1/chat/completions")).toBe(
      "https://api.example.com/v1/chat/completions",
    );
    expect(buildChatCompletionsUrl("https://api.example.com/v1/chat/completions/")).toBe(
      "https://api.example.com/v1/chat/completions",
    );
  });

  it("does not treat a suffix match as the endpoint", () => {
    expect(buildChatCompletionsUrl("https://api.example.com/v1/chat/completions-proxy")).toBe(
      "https://api.example.com/v1/chat/completions-proxy/chat/completions",
    );
  });
});

describe("normalizeChatMessages", () => {
  it("returns an empty list for non-array input", () => {
    expect(normalizeChatMessages(null)).toEqual([]);
    expect(normalizeChatMessages("user: hi")).toEqual([]);
    expect(normalizeChatMessages({ role: "user", content: "hi" })).toEqual([]);
  });

  it("normalizes roles, strips think blocks and preserves timestamps", () => {
    expect(
      normalizeChatMessages([
        { role: "system", content: "rules", at: 1 },
        { role: "user", content: "<think>hidden</think>hello", at: 2 },
        { role: "tool", content: "tool output" },
      ]),
    ).toEqual([
      { role: "system", content: "rules", at: 1 },
      { role: "user", content: "hello", at: 2 },
      { role: "assistant", content: "tool output" },
    ]);
  });

  it("drops blank and think-only entries and non-finite timestamps", () => {
    expect(
      normalizeChatMessages([
        { role: "user", content: "   " },
        { role: "user", content: "<think>only</think>" },
        { role: "user", content: "ok", at: Number.NaN },
        null,
        7,
      ]),
    ).toEqual([{ role: "user", content: "ok" }]);
  });

  it("keeps only the last 24 messages", () => {
    const input = Array.from({ length: 30 }, (_, index) => ({ role: "user", content: `m${index}` }));
    const output = normalizeChatMessages(input);
    expect(output).toHaveLength(24);
    expect(output[0]?.content).toBe("m6");
    expect(output.at(-1)?.content).toBe("m29");
  });
});

describe("appendApiLog", () => {
  it("resolves the log path under Electron userData", () => {
    expect(getApiLogPath()).toBe(path.join(root, "chat-api.log"));
  });

  it("writes label, request JSON, raw and cleaned responses with separators", () => {
    appendApiLog("primary", [{ role: "user", content: "hello" }], "{\"raw\":true}", "");
    const text = fs.readFileSync(path.join(root, "chat-api.log"), "utf8");
    expect(text).toContain("] primary");
    expect(text).toContain("REQUEST");
    expect(text).toContain('"content": "hello"');
    expect(text).toContain("RAW RESPONSE");
    expect(text).toContain('{"raw":true}');
    expect(text).toContain("CLEANED");
    expect(text).toContain("(empty)");
    expect(text).toContain("=".repeat(80));
  });

  it("appends rather than replacing earlier entries", () => {
    appendApiLog("first", [], "one", "one");
    appendApiLog("second", [], "two", "two");
    const text = fs.readFileSync(path.join(root, "chat-api.log"), "utf8");
    expect(text.match(/\] first/g)).toHaveLength(1);
    expect(text.match(/\] second/g)).toHaveLength(1);
    expect(text.indexOf("] first")).toBeLessThan(text.indexOf("] second"));
  });

  it("silently ignores write failures", () => {
    mocks.userData = path.join(root, "not-a-directory");
    fs.writeFileSync(mocks.userData, "file", "utf8");
    expect(() => appendApiLog("broken", [], "raw", "clean")).not.toThrow();
  });
});
