import { describe, expect, it } from "vitest";
import type { ToolCall } from "../vendors/types";
import {
  ToolCallArgumentsError, invalidToolCallArguments, parseToolCallArgs,
  tryParseToolCallArgs, toolCallFingerprint,
} from "./types";

const call = (args: string): ToolCall => ({ id: "call-1", name: "read_file", arguments: args });

describe("tool call arguments", () => {
  it.each(["{}", '{"path":"a.ts","nested":{"x":[1,null,true]},"empty":""}', " \n {\"zero\":0} \t"])(
    "parses object arguments without changing values: %s", (raw) => {
      expect(parseToolCallArgs(call(raw))).toEqual(JSON.parse(raw));
      expect(tryParseToolCallArgs(call(raw))).toEqual(JSON.parse(raw));
    },
  );

  it.each(["", " ", "{", '{"x":}', "undefined", "null", "[]", "[{}]", '"text"', "0", "1.5", "true", "false"])(
    "rejects malformed or non-object JSON: %s", (raw) => {
      expect(() => parseToolCallArgs(call(raw))).toThrow(ToolCallArgumentsError);
      expect(() => parseToolCallArgs(call(raw))).toThrow(/^工具参数必须是有效的 JSON 对象$/);
      expect(tryParseToolCallArgs(call(raw))).toBeUndefined();
    },
  );

  it("treats inaccessible argument data as invalid", () => {
    const broken = { id: "x", name: "x", get arguments(): string { throw new Error("unavailable"); } };
    // Accessing arguments happens within the parser's validation boundary.
    expect(() => parseToolCallArgs(broken)).toThrow(ToolCallArgumentsError);
    expect(tryParseToolCallArgs(broken)).toBeUndefined();
  });

  it("exposes a named Error and a structured invalid-arguments observation", () => {
    const error = new ToolCallArgumentsError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ToolCallArgumentsError");
    expect(error.message).toBe("工具参数必须是有效的 JSON 对象");
    expect(invalidToolCallArguments(call("[]"))).toEqual({
      outcome: "failure", category: "invalid_arguments", tool: "read_file",
      toolSideEffect: "read_only", message: error.message,
    });
  });
});

describe("toolCallFingerprint", () => {
  it("handles empty arguments and includes the tool identity", () => {
    expect(toolCallFingerprint("read_file", {})).toBe("read_file()");
    expect(toolCallFingerprint("a", {})).not.toBe(toolCallFingerprint("b", {}));
  });

  it("sorts top-level keys without changing the arguments", () => {
    const args = { z: "last", a: 0, m: false };
    expect(toolCallFingerprint("tool", args)).toBe("tool(a=0,m=false,z=last)");
    expect(toolCallFingerprint("tool", args)).toBe(toolCallFingerprint("tool", { m: false, a: 0, z: "last" }));
    expect(Object.keys(args)).toEqual(["z", "a", "m"]);
    expect(toolCallFingerprint("tool", { a: "changed" })).not.toBe(toolCallFingerprint("tool", { a: "original" }));
  });
});
