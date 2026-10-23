import type { SidebarLayoutApi } from "../../../../../shared/sidebar-layout";
import type { ChatMessage, ChatSession, ChatSessionMeta, ConversationMode, PendingChatMessage, ToolFileChange } from "../../../../../shared/chat-types";
import type { PopQuizCard, PopQuizResolveResponse, PopQuizSettledPayload, PopQuizSubmission } from "../../../../../shared/pop-quiz";
import type { ApprovalRequest as PermissionApprovalRequest, ApprovalSettledPayload as PermissionApprovalSettled } from "../../../../../shared/permission-approval";

export type { PermissionApprovalRequest, PermissionApprovalSettled };

export type PendingClaimResult =
  | { error: string; ok: false }
  | { claimed: false; ok: true }
  | {
    session: ChatSession; remainingQueue: PendingChatMessage[]; resumeFromRunId?: string;
    visibleContent: string; userMessage: ChatMessage; claimed: true; ok: true;
  };
export type PendingMutationResult =
  | { queue?: PendingChatMessage[]; error: string; ok: false }
  | { queue: PendingChatMessage[]; ok: true };

export type ChatStoreApi = {
  notifyReactReady: () => void;
  onReactSwitchSession: (callback: (sessionId: string) => void) => () => void;
  onChanged: (callback: () => void) => () => void;
  setActiveSession: (sessionId: string | null, mode?: ConversationMode) => Promise<unknown>;
  openWorkspace: (workspaceRoot: string) => Promise<{ ok: boolean; error?: string }>;
  setWorkspace: (sessionId: string, workspaceRoot: string) => Promise<{ ok: boolean; error?: string }>;
  pickWorkspaceFolder: () => Promise<{ ok: boolean; path?: string; displayName?: string; error?: string }>;
  setModelProfile: (id: string, modelProfileId?: string) => Promise<ChatSession | null>;
  setPinned: (id: string, pinned: boolean) => Promise<ChatSession | null>;
  pendingAdjust: (id: string, messageId: string) => Promise<PendingMutationResult>;
  pendingEdit: (id: string, messageId: string, update: { rawContent: string; visibleContent: string; userSticker?: string }) => Promise<PendingMutationResult>;
  pendingCompleteDispatch: (id: string, messageId: string) => Promise<{ ok: boolean; error?: string }>;
  pendingClaim: (id: string) => Promise<PendingClaimResult>;
  pendingRemove: (id: string, messageId: string) => Promise<{ ok: boolean; error?: string }>;
  pendingList: (id: string) => Promise<PendingChatMessage[] | null>;
  pendingEnqueue: (id: string, entry: Omit<PendingChatMessage, "enqueuedAt">) => Promise<
    { ok: true; queue: PendingChatMessage[] } | { ok: false; error?: string; canceled?: boolean }
  >;
  delete: (id: string) => Promise<boolean>;
  rename: (id: string, title: string) => Promise<ChatSession | null>;
  replaceTail: (id: string, startIndex: number, messages: ChatMessage[]) => Promise<ChatSession | null>;
  upsert: (id: string, message: ChatMessage) => Promise<ChatSession | null>;
  append: (id: string, message: ChatMessage) => Promise<ChatSession | null>;
  create: (input: { identityId: null; mode: ConversationMode; title?: string; temporary?: boolean }) => Promise<ChatSession>;
  exportWorkMarkdown: (id: string) => Promise<{ ok: boolean; canceled?: boolean; error?: string }>;
  get: (id: string) => Promise<ChatSession | null>;
  list: (options?: { mode?: ConversationMode }) => Promise<ChatSessionMeta[]>;
  sidebarLayout?: SidebarLayoutApi;
};

export type SidebarApi = { openSettings: (section?: string) => void };
export type AguiEvent = {
  taskResult?: import("../../../../../shared/chat-types").ToolTaskResult;
  changes?: ToolFileChange[];
  status?: string;
  stepName?: string;
  toolCallDisplayName?: string;
  toolCallName?: string;
  toolCallId?: string;
  value?: unknown;
  name?: string;
  content?: string;
  error?: string;
  message?: string;
  delta?: string;
  messageId?: string;
  runId?: string;
  threadId?: string;
  type?: string;
  errorSource?: import("../../../../../shared/run-failure").RunFailureSource;
  code?: string;
};
export type CandidateTextEventValue =
  | { roundId: string; action: "discard" }
  | { delta: string; roundId: string; action: "delta" };

export type AguiApi = {
  getInterruptedRun?: (sessionId: string) => Promise<{ runId: string; rounds: number; todoCount: number; updatedAt: number } | null>;
  reportRunPersisted?: (payload: { runId: string; finalMessageId?: string }) => void;
  cancel: (runId?: string) => Promise<unknown>;
  onEvent: (callback: (event: AguiEvent) => void) => () => void;
  run: (input: {
    transcriptRewind?: { disposition: "keep_user" | "replace_user"; anchorUserTurnId: string };
    takeoverFromRunId?: string;
    resumeFromRunId?: string;
    recoveryContext?: string;
    imageAttachments?: Array<{ mime?: string; filePath: string; name: string }>;
    sessionId: string;
    assistantTurnId: string;
    userTurnId: string;
    messages: Array<{ at?: number; content: string; role: "user" | "model" }>;
  }) => Promise<{ success: boolean; runId: string; error?: string }>;
};

export type ChoiceApi = { resolve: (id: string, value: unknown) => Promise<{ ok: boolean }> };
export type SettingsApprovalApi = {
  onPopQuizSettled: (callback: (settlement: PopQuizSettledPayload) => void) => () => void;
  skipPopQuiz: (quizId: string) => Promise<{ ok: boolean; error?: string }>;
  resolvePopQuiz: (submission: PopQuizSubmission) => Promise<PopQuizResolveResponse>;
  onPopQuizRequest: (callback: (card: PopQuizCard) => void) => () => void;
  onPermissionApprovalSettled: (callback: (settlement: PermissionApprovalSettled) => void) => () => void;
  resolvePermissionApproval: (id: string, allowed: boolean) => Promise<{ ok: boolean }>;
  onPermissionApprovalRequest: (callback: (request: PermissionApprovalRequest) => void) => () => void;
};
export type PublicModelConfig = { stickerSize?: "small" | "standard" | "large"; displayName?: string; model?: unknown };
export type ModelConfigApi = {
  onChanged: (callback: (config: PublicModelConfig) => void) => () => void;
  get: () => Promise<PublicModelConfig>;
};

export function chatStore(): ChatStoreApi | undefined {
  const bridge = window as typeof window & { chatStore?: ChatStoreApi };
  return bridge.chatStore;
}
export function sidebarApi(): SidebarApi | undefined {
  const bridge = window as typeof window & { sidebar?: SidebarApi };
  return bridge.sidebar;
}
export function aguiApi(): AguiApi | undefined {
  const bridge = window as typeof window & { agui?: AguiApi };
  return bridge.agui;
}
export function choiceApi(): ChoiceApi | undefined {
  const bridge = window as typeof window & { choice?: ChoiceApi };
  return bridge.choice;
}
export function settingsApprovalApi(): SettingsApprovalApi | undefined {
  const bridge = window as typeof window & { settings?: SettingsApprovalApi };
  return bridge.settings;
}
