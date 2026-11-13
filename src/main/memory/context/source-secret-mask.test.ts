import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertContextSecretFree, maskContextSecrets } from "./source-secret-screen";
import { validateUnit } from "./token-budget";

const maskedGhStatus = "github.com\n  - Active account: true\n  - Token: gho_" + "*".repeat(36) + "\n  - Token scopes: 'repo'\n";
const leaked = /CANARY|SYNTHETIC_ONLY|SYNTHETIC_SECRET|abcdefghijklmnop/;

describe("maskContextSecrets", () => {
  it.each([
    "token: gho_CANARY********", "token: ********CANARY", 'token: "******** CANARY"', 'token: "********" + CANARY',
    "token: ********​CANARY", "password: ********;SYNTHETIC_ONLY_CANARY", "token: ********}SYNTHETIC_ONLY_CANARY",
    { token: "gho_CANARY********" }, { token: "******** CANARY" },
    JSON.stringify({ stdout: maskedGhStatus, access_token: "SYNTHETIC_ONLY_CANARY" }), '{"token":123456}',
    '{"api_key=SYNTHETIC_ONLY_CANARY":"ok"}', '{"ghp_abcdefghijklmnop123456":"ok"}',
    maskedGhStatus + "api_key=SYNTHETIC_ONLY_CANARY", "token: ****; password=SYNTHETIC_ONLY_CANARY",
    "api_key=SECRET_CANARY_1234567890", "My passphrase is SYNTHETIC_ONLY_SECRET", "密码：SYNTHETIC_ONLY_SECRET",
    "Authorization: Bearer SYNTHETIC_ONLY_TOKEN", "sk-abcdefghijklmnopqrstuvwxyz123456",
    { rawAssistant: { nested: { api_key: "SYNTHETIC_ONLY_SECRET" } } },
    { toolCalls: [{ arguments: '{"refresh_token":"SYNTHETIC_ONLY_SECRET"}' }] },
    "-----BEGIN PRIVATE KEY-----\nSYNTHETIC_ONLY_SECRET\n-----END PRIVATE KEY-----\nafter",
    '{"token":"SYNTHETIC_ONLY_CANARY","token":"********"}',
  ])("hides every value the screen rejects, and the result passes the screen %#", value => {
    const masked = maskContextSecrets(value);
    expect(() => assertContextSecretFree(masked)).not.toThrow();
    expect(JSON.stringify(masked)).not.toMatch(leaked);
  });

  it.each([
    "Explain the api_key field and password validation", "请解释密码字段如何校验，不要保存密钥",
    { name: "api_key", type: "string" }, { password: "", access_token: null }, maskedGhStatus,
    "type Login = { api_key: string; password: string }", "The token is a unit of text.",
  ])("leaves clean content untouched %#", value => {
    expect(maskContextSecrets(value)).toBe(value);
  });

  it("keeps code readable: only the flagged value is masked, to the end of its line", () => {
    const code = "function transcriptState(token:object,value:object):State {\n  return state;\n}\nconst apiKey = model.apiKey;\nconst x = 1;";
    const masked = maskContextSecrets(code);
    expect(masked).toBe("function transcriptState(token:***\n  return state;\n}\nconst apiKey = ***\nconst x = 1;");
  });

  it("lets a run read real source files that tripped the screen in 1.1.3", () => {
    for (const file of ["src/main/memory/context/main-context.ts"]) {
      const text = fs.readFileSync(path.resolve(file), "utf8");
      expect(() => assertContextSecretFree(text)).toThrow("MEMORY_CONTEXT_TRANSCRIPT_SECRET");
      const masked = maskContextSecrets(text);
      expect(() => assertContextSecretFree(masked)).not.toThrow();
      const before = text.normalize("NFKC").split(/\r?\n/), after = masked.split(/\r?\n/);
      expect(after).toHaveLength(before.length);
      expect(after.filter((line, index) => line === before[index]).length / before.length).toBeGreaterThan(0.9);
    }
  });

  it("derives a message's text from its masked content blocks, so the two stay identical", () => {
    // Masking text and content separately gave `{"api_key":***` in text but `{"api_key":"***"}` in the block,
    // and validateUnit (text must equal the joined text blocks) failed with MEMORY_CONTEXT_INPUT_INVALID.
    const blocks = [{ type: "text", text: "Please inspect this config" }, { type: "text", text: "{\"api_key\":\"SYNTHETIC_SECRET\"}" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }];
    const message = { role: "user" as const, text: blocks.filter(block => block.type === "text").map(block => block.text).join("\n"), content: blocks };
    const masked = maskContextSecrets(message);
    expect(JSON.stringify(masked)).not.toContain("SYNTHETIC_SECRET");
    expect(masked.text).toBe((masked.content as Array<{ type: string; text?: string }>).filter(block => block.type === "text").map(block => block.text).join("\n"));
    expect(() => validateUnit({ id: "u", kind: "recent", messages: [masked] })).not.toThrow();
    // A secret split across two text blocks passes block by block; the joined text must still come out masked.
    const split = [{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }, { type: "text", text: "password:" }, { type: "text", text: "hunter2SYNTHETIC_SECRET" }];
    const splitMasked = maskContextSecrets({ role: "user" as const, text: "password:\nhunter2SYNTHETIC_SECRET", content: split });
    expect(JSON.stringify(splitMasked)).not.toContain("SYNTHETIC_SECRET");
    expect(() => validateUnit({ id: "u", kind: "recent", messages: [splitMasked] })).not.toThrow();
    expect((splitMasked.content as Array<{ type: string }>)[0]?.type).toBe("image_url");
    const plain = { role: "user" as const, text: "token = abc123secretvalue", content: "token = abc123secretvalue" };
    const maskedPlain = maskContextSecrets(plain);
    expect(maskedPlain.text).toBe(maskedPlain.content);
  });

  it("renames a credential-bearing key the same way wherever the same arguments appear", () => {
    // Codex review on #47: keys were renamed by traversal position (***15 vs ***22), so a tool call's arguments and its
    // raw input no longer matched and validateUnit threw MEMORY_CONTEXT_TOOL_PAIR_INVALID.
    const args = { "api_key=CANARY": "ok", "token=CANARY2": "x", plain: "value" };
    const message = { role: "assistant" as const, text: "", toolCalls: [{ id: "call-1", name: "read_file", arguments: JSON.stringify(args) }], toolCallIds: ["call-1"],
      rawAssistant: [{ type: "text", text: "" }, { type: "tool_use", id: "call-1", name: "read_file", input: args }] };
    const tool = { role: "tool" as const, text: "done", toolCallId: "call-1", name: "read_file" };
    expect(() => validateUnit({ id: "u", kind: "recent", messages: [message, tool] })).not.toThrow();
    const masked = maskContextSecrets([message, tool]);
    expect(JSON.stringify(masked)).not.toContain("CANARY");
    expect(() => validateUnit({ id: "u", kind: "recent", messages: masked })).not.toThrow();
  });

  it("renames clashing credential keys alike when the two copies list them in different orders", () => {
    // Codex review on #47: the raw tool input is key-sorted while the arguments JSON keeps the model's order,
    // so numbering clashes by position paired `api_key=***` with different values in the two copies.
    const message = { role: "assistant" as const, text: "", toolCalls: [{ id: "call-1", name: "read_file", arguments: '{"api_key=Z":"one","api_key=A":"two"}' }],
      toolCallIds: ["call-1"], rawAssistant: [{ type: "text", text: "" }, { type: "tool_use", id: "call-1", name: "read_file", input: { "api_key=A": "two", "api_key=Z": "one" } }] };
    const tool = { role: "tool" as const, text: "done", toolCallId: "call-1", name: "read_file" };
    expect(() => validateUnit({ id: "u", kind: "recent", messages: [message, tool] })).not.toThrow();
    const masked = maskContextSecrets([message, tool]);
    expect(() => validateUnit({ id: "u", kind: "recent", messages: masked })).not.toThrow();
    expect(JSON.parse((masked[0] as typeof message).toolCalls[0].arguments)).toEqual((masked[0] as typeof message).rawAssistant[1].input);
  });

  it("names thousands of clashing masked keys in linear time", () => {
    // Codex review on #47: each clash restarted its suffix search at 2, so 9,000 keys took about 11 s.
    const args = Object.fromEntries(Array.from({ length: 9000 }, (_, i) => [`api_key=${i}`, "x"]));
    const began = performance.now();
    const masked = maskContextSecrets(args) as Record<string, unknown>;
    expect(performance.now() - began).toBeLessThan(2000);
    expect(Object.keys(masked)).toHaveLength(9000);
    expect(new Set(Object.keys(masked)).size).toBe(9000);
  });

  it("masks many assignments in one pass, not in time quadratic in their number", () => {
    // Codex review on #47: 30,000 lines took about 50 s because each match rebuilt the whole string.
    const pasted = "api_key=CANARY\n".repeat(30000);
    const began = performance.now();
    const masked = maskContextSecrets(pasted);
    expect(performance.now() - began).toBeLessThan(2000);
    expect(masked).not.toContain("CANARY");
    expect(masked.split("\n")).toHaveLength(30001);
    expect(maskContextSecrets("a=1\napi_key=CANARY; token=x\nb\ntoken=***\nc")).toBe("a=1\napi_key=***\nb\ntoken=***\nc");
  });

  it("masks inside tool results serialized as JSON and keeps the JSON valid", () => {
    const tool = JSON.stringify({ output: "const token = readToken();\nok", exitCode: 0 });
    const masked = maskContextSecrets([{ role: "tool", text: tool }]);
    expect(JSON.parse(masked[0].text)).toEqual({ output: "const token = ***\nok", exitCode: 0 });
  });
});
