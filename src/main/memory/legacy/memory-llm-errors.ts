// Memory LLM 的错误类型集合：调用方据此区分超时、HTTP、协议与配置问题。

export class MemoryLlmTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly operation: string;

  constructor(timeoutMs: number, operation: string) {
    super(`Memory LLM [${operation}] timed out after ${timeoutMs}ms`);
    this.timeoutMs = timeoutMs;
    this.operation = operation;
    this.name = "MemoryLlmTimeoutError";
  }
}

export class MemoryLlmHttpError extends Error {
  readonly statusCode: number;
  readonly operation: string;
  readonly responseBody?: string;

  constructor(statusCode: number, operation: string, responseBody?: string) {
    super(`Memory LLM [${operation}] HTTP ${statusCode}`);
    this.statusCode = statusCode;
    this.operation = operation;
    this.responseBody = responseBody;
    this.name = "MemoryLlmHttpError";
  }
}

export class MemoryLlmProtocolError extends Error {
  readonly operation: string;
  readonly detail: string;

  constructor(operation: string, detail: string) {
    super(`Memory LLM [${operation}] protocol error: ${detail}`);
    this.operation = operation;
    this.detail = detail;
    this.name = "MemoryLlmProtocolError";
  }
}


// 配置缺失类错误（例如没有 API key），没有 operation 概念
export class MemoryLlmConfigurationError extends Error {
  constructor(detail: string) {
    const text = `Memory LLM configuration error: ${detail}`;
    super(text);
    this.name = "MemoryLlmConfigurationError";
  }
}
