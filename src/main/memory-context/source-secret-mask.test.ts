import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertContextSecretFree, maskContextSecrets } from "./source-secret-screen";

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
    for (const file of ["src/main/memory-context/main-context.ts"]) {
      const text = fs.readFileSync(path.resolve(file), "utf8");
      expect(() => assertContextSecretFree(text)).toThrow("MEMORY_CONTEXT_TRANSCRIPT_SECRET");
      const masked = maskContextSecrets(text);
      expect(() => assertContextSecretFree(masked)).not.toThrow();
      const before = text.normalize("NFKC").split(/\r?\n/), after = masked.split(/\r?\n/);
      expect(after).toHaveLength(before.length);
      expect(after.filter((line, index) => line === before[index]).length / before.length).toBeGreaterThan(0.9);
    }
  });

  it("masks inside tool results serialized as JSON and keeps the JSON valid", () => {
    const tool = JSON.stringify({ output: "const token = readToken();\nok", exitCode: 0 });
    const masked = maskContextSecrets([{ role: "tool", text: tool }]);
    expect(JSON.parse(masked[0].text)).toEqual({ output: "const token = ***\nok", exitCode: 0 });
  });
});
