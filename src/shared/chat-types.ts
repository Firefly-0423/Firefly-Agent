import type { MusicCardData } from "./music-card";
import type { TodoItem } from "./todo-types";
import type { TaskDelegationPresentation } from "./task-session";
import type { ContextUsageSnapshot } from "./context-usage";
import type { ModelExecutionEvent, TaskWriteEvidence } from "./agent-execution-evidence";
export type ChatRole = "user" | "model";
export type ChatSessionPurpose = "proactive-chat";
export type ConversationMode = "chat" | "work" | "code";
export type ChatStickerId = "playful" | "love-happy" | "confident" | "serious" | "calm" | "peek" | "clingy-confused" | "love-calm";
export type AnyStickerId = string;
export type ToolTaskResult = {
    agentId: string;
    error?: {
        code: string;
        message: string;
    };
    executionEvents?: ModelExecutionEvent[];
    sessionId: string;
    status: import("./task-session").TaskSessionStatus;
    text: string;
    truncated?: boolean;
    writes?: TaskWriteEvidence[];
};
export type ToolExecutionRecord = {
    argsText?: string;
    changes?: ToolFileChange[];
    displayName?: string;
    id: string;
    name: string;
    result?: string;
    roundId?: string;
    seq?: number;
    status: "running" | "success" | "error";
    taskResult?: ToolTaskResult;
};
export type ToolDiffLineType = "context" | "add" | "remove" | "hunk";
export type ToolDiffLine = {
    text: string;
    type: ToolDiffLineType;
};
export type ToolFileChange = {
    deletions: number;
    diff?: ToolDiffLine[];
    file: string;
    insertions: number;
    kind: "added" | "modified" | "deleted" | "renamed";
    truncated?: boolean;
};
export type RunActivityRecord = {
    activeReasoningStartedAt?: number;
    completedAt?: number;
    keepExpanded?: boolean;
    reasoningMs: number;
    startedAt: number;
};
export type ProcessMessageRecord = {
    afterToolCount?: number;
    content: string;
    id: string;
    interrupted?: boolean;
    roundId?: string;
    seq?: number;
};
export type ReasoningBlock = {
    afterToolCount?: number;
    content: string;
    id: string;
    roundId?: string;
    seq?: number;
    streaming?: boolean;
};
export type AgentRoundRecord = {
    completedAt?: number;
    id: string;
    startedAt: number;
    status: "running" | "completed";
};
export type TaskDelegationDisplayRecord = TaskDelegationPresentation & {
    roundId?: string;
};
export type ChatMessageChannel = "wechat" | "feishu" | "qq" | "qqbot";
export type ChatMessageChannelSource = {
    channel: ChatMessageChannel;
    chatType?: "private" | "group";
    senderName?: string;
};
export type ChatMessage = {
    agentRounds?: AgentRoundRecord[];
    answersUserMessageId?: string;
    at: number;
    attachments?: MessageAttachment[];
    channelSource?: ChatMessageChannelSource;
    content: string;
    contextUsage?: ContextUsageSnapshot;
    id: string;
    modelContext?: string;
    musicCard?: MusicCardData;
    processMessages?: ProcessMessageRecord[];
    reasoning?: string;
    reasoningBlocks?: ReasoningBlock[];
    role: ChatRole;
    runActivity?: RunActivityRecord;
    runSnapshot?: {
        runId?: string;
        status: "running" | "waiting_user" | "interrupted" | "terminal";
        terminalStatus?: "success" | "cancelled" | "timeout" | "runtime_error";
        todos?: TodoItem[];
        updatedAt: number;
    };
    sSettlement?: {
        assistantEntryId: string;
        originalText: string;
        runId: string;
        state: "pending" | "unknown" | "success" | "interrupted";
    };
    sticker?: string | null;
    taskDelegations?: TaskDelegationDisplayRecord[];
    toolExecutions?: ToolExecutionRecord[];
    ttsCacheKey?: string;
    ttsCacheVersion?: string;
    workReadReport?: WorkReadReport;
};
export type MessageAttachment = ImageMessageAttachment | DocumentMessageAttachment;
export type ImageMessageAttachment = {
    caption?: string;
    filePath: string;
    hasAnnotations?: boolean;
    kind: "image";
    mime: string;
    name: string;
    previewUrl?: string;
    status: "pending" | "done" | "error";
};
export type DocumentMessageAttachment = {
    chunks?: number;
    filePath: string;
    kind: "document";
    name: string;
    processedKind?: "text" | "indexed" | "empty" | "unsupported";
    readScope?: WorkReadScope;
    reason?: string;
    status: "pending" | "done" | "error";
};
export type WorkReadScope = {
    endLine: number;
    name: string;
    partialAccepted: boolean;
    path: string;
    sha256: string;
    totalLines: number;
};
export type WorkReadReport = {
    files: Array<{
        coveredLines: number;
        name: string;
        requiredLines: number;
        status: "complete" | "partial" | "missing" | "changed" | "unverified";
        totalLines: number;
    }>;
    status: "complete" | "partial" | "missing" | "changed" | "unverified";
};
export type ConversationWorkspaceBinding = {
    boundAt: number;
    displayName: string;
    workspaceRoot: string;
};
export type PendingChatAttachment = {
    caption?: string;
    filePath: string;
    hasAnnotations?: boolean;
    kind: "image" | "document";
    mime?: string;
    name: string;
    readScope?: WorkReadScope;
};
export type PendingChatMessage = {
    adjustRunId?: string;
    attachments?: PendingChatAttachment[];
    enqueuedAt: number;
    id: string;
    rawContent: string;
    requireDocumentRead?: boolean;
    resumeFromRunId?: string;
    userSticker?: string;
    visibleContent: string;
};
export type PendingDispatchState = {
    claimedAt: number;
    messageId: string;
};
export type ChatSession = {
    createdAt: number;
    currentContextUsage?: ContextUsageSnapshot;
    id: string;
    identityId: string | null;
    messages: ChatMessage[];
    mode: ConversationMode;
    modelProfileId?: string;
    pendingDispatch?: PendingDispatchState;
    pendingMessages?: PendingChatMessage[];
    pinned?: boolean;
    purpose?: ChatSessionPurpose;
    schemaVersion: 1;
    temporary?: true;
    title: string;
    titleIsCustom?: boolean;
    updatedAt: number;
    workspaceBinding?: ConversationWorkspaceBinding;
};
export type ChatSessionMeta = {
    createdAt: number;
    id: string;
    identityId: string | null;
    messageCount: number;
    mode: ConversationMode;
    pinned?: boolean;
    purpose?: ChatSessionPurpose;
    title: string;
    updatedAt: number;
    workspaceDisplayName?: string;
    workspaceRoot?: string;
};
export const CHAT_SCHEMA_VERSION = 1 as const;
