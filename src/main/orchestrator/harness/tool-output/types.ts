export type ToolOutputOutcome = "unknown" | "failure" | "success";
export type ToolOutputRef = {
  createdAt: number; truncatedForModel: boolean; codePoints: number; bytes: number;
  toolName: string; toolCallId: string; runId: string; resultRef: string; recordId: string;
};
export type PutToolOutputInput = {
  truncatedForModel: boolean; output: string; outcome: ToolOutputOutcome; toolName: string;
  toolCallId: string; runId: string; ownerSessionId?: string; conversationId: string;
};
export type ReadToolOutputInput = { length: number; offset: number; resultRef: string; ownerSessionId?: string; conversationId: string };
export type ReadToolOutputResult = { resultRef: string; totalCodePoints: number; offset: number; content: string };
export type FindToolOutputInput = { query: string; resultRef: string; ownerSessionId?: string; conversationId: string };
export type FindToolOutputMatch = { preview: string; offset: number };
export type FindToolOutputResult = { matches: FindToolOutputMatch[]; totalCodePoints: number; resultRef: string };
export type ToolOutputStore = {
  deleteConversation(conversationId: string): Promise<void>;
  find(input: FindToolOutputInput): Promise<FindToolOutputResult | null>;
  read(input: ReadToolOutputInput): Promise<ReadToolOutputResult | null>;
  put(input: PutToolOutputInput): Promise<ToolOutputRef>;
};
