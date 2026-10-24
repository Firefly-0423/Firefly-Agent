import type { Position } from "vscode-languageserver-types";

// 语义操作清单：模型侧可选值，顺序与工具描述保持一致。
const OPERATION_NAMES = [
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
] as const;

export const LSP_OPERATIONS = OPERATION_NAMES;
export type LspOperation = (typeof LSP_OPERATIONS)[number];

const ERROR_CODE_NAMES = [
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
] as const;

export const LSP_ERROR_CODES = ERROR_CODE_NAMES;
export type LspErrorCode = (typeof LSP_ERROR_CODES)[number];

export interface LspServerCommand {
  command: string;
  args: string[];
}

export interface LspServerDefinition {
  id: string;
  extensions: string[];
  commands: LspServerCommand[];
  rootMarkers: string[];
  installHint: string;
  initializationOptions?: unknown;
}

// 设置页保存的本地覆盖项，只允许覆盖已知服务的少数字段。
export interface LspServerOverride {
  id: string;
  command?: string;
  args?: string[];
  extensions?: string[];
  initializationOptions?: unknown;
}

export interface LspPositionInput {
  // 模型看到的行号与列号都从 1 开始。
  line: number;
  character: number;
}

export interface LspQuery {
  operation: LspOperation;
  filePath?: string;
  line?: number;
  character?: number;
  query?: string;
  // 调用层级第二步使用的条目，应来自上一次 prepareCallHierarchy 的返回值。
  item?: Record<string, unknown>;
}

export interface LspToolResult {
  serverId: string;
  operation: LspOperation;
  workspaceRoot: string;
  items: unknown[];
  message: string;
}

export class LspContractError extends Error {
  readonly code: LspErrorCode;

  constructor(code: LspErrorCode, message: string = code) {
    super(`${code}: ${message}`);
    this.code = code;
    this.name = "LspContractError";
  }
}

function isOneBased(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

/** 把模型侧的 1 基坐标换算成协议要求的 0 基坐标；非法值直接抛出契约错误。 */
export function toProtocolPosition(input: LspPositionInput): Position {
  if (!isOneBased(input.line) || !isOneBased(input.character)) {
    throw new LspContractError("LSP_POSITION_INVALID", "line 和 character 必须是从 1 开始的整数");
  }
  return { line: input.line - 1, character: input.character - 1 };
}
