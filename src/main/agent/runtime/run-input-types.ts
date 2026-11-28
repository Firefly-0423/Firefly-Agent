import type { ConversationMode } from "../../../shared/chat-types";
import type { RelationshipChannel } from "../../knowledge/relationship/relationship-log";
import type { TranscriptRewindRequest } from "../../conversation/transcript/conversation-transcript-coordinator";
import type { MainAttachmentGrant } from "../../memory/context/main-attachment-projection";
import type { FireflyRunOptions } from "./firefly-agent";

/** 聊天窗口（或渠道、插件）发起一次运行时交给运行层的输入，以及组装运行选项的函数签名。 */
export interface AguiRunInput {
  messages: unknown[];
  userTurnId?: string;
  assistantTurnId?: string;
  sessionId?: string;
  workspaceBindingSessionId?: string | null;
  channel?: RelationshipChannel;
  promptSource?: "conversation" | "plugin-agent";
  promptChannel?: string;
  executionMode?: ConversationMode;
  mode?: ConversationMode;
  attachments?: { name: string; text: string }[];
  workDocuments?: Array<{
    name: string; path: string; requiredEndLine?: number;
    totalLines?: number; partialAccepted?: boolean;
  }>;
  imageAttachments?: { name: string; filePath: string; mime?: string }[];
  recoveryContext?: string;
  resumeFromRunId?: string;
  takeoverFromRunId?: string;
  modelProfileId?: string;
  transcriptRewind?: TranscriptRewindRequest;
  useTranscriptContext?: boolean;
}

export interface MainBuildOptionsContext {
  attachmentGrant?: MainAttachmentGrant;
}
export type BuildOptionsFn = ((input: AguiRunInput, mainContext?: MainBuildOptionsContext) => Promise<{
  options: FireflyRunOptions;
  latestUserText: string;
}>) & {
  prepareTranscript?: (input: AguiRunInput) => Promise<void>;
};
