import type { Position } from "vscode-languageserver-types";

// 语义操作清单：模型侧可选值，顺序与工具描述保持一致。
const NAVIGATION_OPERATIONS = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "diagnostics",
] as const;

const CALL_HIERARCHY_OPERATIONS = [
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
] as const;

export const LSP_OPERATIONS = [...NAVIGATION_OPERATIONS, ...CALL_HIERARCHY_OPERATIONS] as const;
export type LspOperation = (typeof LSP_OPERATIONS)[number];

const WORKSPACE_ERRORS = [
  "LSP_WORKSPACE_REQUIRED",
  "LSP_PATH_OUTSIDE_WORKSPACE",
  "LSP_FILE_NOT_FOUND",
  "LSP_SERVER_NOT_FOUND",
] as const;

const SERVER_ERRORS = [
  "LSP_SERVER_START_FAILED",
  "LSP_INITIALIZE_TIMEOUT",
  "LSP_REQUEST_TIMEOUT",
  "LSP_REQUEST_FAILED",
  "LSP_UNSUPPORTED_OPERATION",
  "LSP_POSITION_INVALID",
] as const;

export const LSP_ERROR_CODES = [...WORKSPACE_ERRORS, ...SERVER_ERRORS] as const;
export type LspErrorCode = (typeof LSP_ERROR_CODES)[number];

export interface LspServerCommand {
  command: string;
  args: string[];
}

interface LspServerIdentity {
  id: string;
  initializationOptions?: unknown;
}

export interface LspServerDefinition extends LspServerIdentity {
  extensions: string[];
  commands: LspServerCommand[];
  rootMarkers: string[];
  installHint: string;
}

// 设置页保存的本地覆盖项，只允许覆盖已知服务的少数字段。
export interface LspServerOverride extends LspServerIdentity {
  command?: string;
  args?: string[];
  extensions?: string[];
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

interface LspResultContext {
  serverId: string;
  operation: LspOperation;
  workspaceRoot: string;
}

export interface LspToolResult extends LspResultContext {
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
