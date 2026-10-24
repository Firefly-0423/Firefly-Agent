import { describe, expect, it } from "vitest";
import { LSP_ERROR_CODES, LSP_OPERATIONS, LspContractError, toProtocolPosition } from "./types";

describe("LspContractError", () => {
  it("消息以错误码为前缀，并带上自定义说明", () => {
    const err = new LspContractError("LSP_FILE_NOT_FOUND", "没有这个文件");
    expect(err.message).toBe("LSP_FILE_NOT_FOUND: 没有这个文件");
    expect(err.code).toBe("LSP_FILE_NOT_FOUND");
  });

  it("省略说明时消息只重复错误码", () => {
    expect(new LspContractError("LSP_REQUEST_FAILED").message).toBe("LSP_REQUEST_FAILED: LSP_REQUEST_FAILED");
  });

  it("是 Error 子类且名称固定", () => {
    const err = new LspContractError("LSP_SERVER_NOT_FOUND");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("LspContractError");
  });
});

describe("错误码与操作清单", () => {
  it("错误码无重复，且都以 LSP_ 开头", () => {
    expect(new Set(LSP_ERROR_CODES).size).toBe(LSP_ERROR_CODES.length);
    for (const code of LSP_ERROR_CODES) expect(code.startsWith("LSP_")).toBe(true);
  });

  it("导出的错误码列表完整且顺序固定：删除或改名任何一个都会失败", () => {
    expect([...LSP_ERROR_CODES]).toEqual([
      "LSP_WORKSPACE_REQUIRED",
      "LSP_PATH_OUTSIDE_WORKSPACE",
      "LSP_FILE_NOT_FOUND",
      "LSP_SERVER_NOT_FOUND",
      "LSP_SERVER_START_FAILED",
      "LSP_INITIALIZE_TIMEOUT",
      "LSP_REQUEST_TIMEOUT",
      "LSP_REQUEST_FAILED",
      "LSP_UNSUPPORTED_OPERATION",
      "LSP_POSITION_INVALID",
    ]);
  });

  it("包含工作区、路径、服务、超时、位置相关的关键错误码", () => {
    for (const code of [
      "LSP_WORKSPACE_REQUIRED",
      "LSP_PATH_OUTSIDE_WORKSPACE",
      "LSP_SERVER_NOT_FOUND",
      "LSP_INITIALIZE_TIMEOUT",
      "LSP_REQUEST_TIMEOUT",
      "LSP_UNSUPPORTED_OPERATION",
      "LSP_POSITION_INVALID",
    ]) {
      expect(LSP_ERROR_CODES).toContain(code);
    }
  });

  it("操作清单覆盖十种语义操作且无重复", () => {
    expect(LSP_OPERATIONS).toHaveLength(10);
    expect(new Set(LSP_OPERATIONS).size).toBe(10);
    // 顺序是发给模型的 operation 枚举顺序，要与工具描述一致，所以不能排序后再比。
    expect([...LSP_OPERATIONS]).toEqual([
      "goToDefinition",
      "findReferences",
      "hover",
      "documentSymbol",
      "workspaceSymbol",
      "goToImplementation",
      "diagnostics",
      "prepareCallHierarchy",
      "incomingCalls",
      "outgoingCalls",
    ]);
  });
});

describe("toProtocolPosition", () => {
  it.each([
    [{ line: 1, character: 1 }, { line: 0, character: 0 }],
    [{ line: 10, character: 3 }, { line: 9, character: 2 }],
    [{ line: 100000, character: 250 }, { line: 99999, character: 249 }],
  ])("把 %j 换算为 %j", (input, expected) => {
    expect(toProtocolPosition(input)).toEqual(expected);
  });

  it.each([
    ["行号为 0", { line: 0, character: 1 }],
    ["列号为 0", { line: 1, character: 0 }],
    ["行号为负数", { line: -4, character: 2 }],
    ["列号为负数", { line: 2, character: -1 }],
    ["行号是小数", { line: 1.5, character: 1 }],
    ["列号是小数", { line: 1, character: 2.25 }],
    ["行号是 NaN", { line: Number.NaN, character: 1 }],
    ["列号是 Infinity", { line: 1, character: Number.POSITIVE_INFINITY }],
  ])("%s 时抛出 LSP_POSITION_INVALID", (_label, input) => {
    let caught: unknown;
    try {
      toProtocolPosition(input);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LspContractError);
    expect((caught as LspContractError).code).toBe("LSP_POSITION_INVALID");
  });

  it("不会修改传入对象", () => {
    const input = { line: 5, character: 5 };
    toProtocolPosition(input);
    expect(input).toEqual({ line: 5, character: 5 });
  });
});
