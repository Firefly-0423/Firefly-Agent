import { FIREFLY_STICKERS } from "../../../../../shared/firefly-stickers";
import { ScrollPill } from "./ScrollPill";
import { isRetiredStickerId } from "../../../../../shared/retired-stickers";
import { StickerImage } from "./StickerImage";
import { Bubble, Think, ThoughtChain, type BubbleItemType } from "@ant-design/x";
import { Component, createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ErrorInfo, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { t, useTranslation } from "../../../i18n";
import { normalizeModelMarkdown } from "./markdown-normalize";
import { resolveAsset } from "../../../../../shared/renderer-base";
import type { AgentRoundRecord, ChatMessageChannelSource, ConversationMode, ProcessMessageRecord, ReasoningBlock, RunActivityRecord, TaskDelegationDisplayRecord, ToolExecutionRecord, ToolFileChange, WorkReadReport } from "../../../../../shared/chat-types";
import type { ContextUsageSnapshot } from "../../../../../shared/context-usage";
import { useUserAvatar } from "../../../hooks/useUserAvatar";
import {
  assistantRenderStages,
  resolveReasoningExpanded,
  updateReasoningExpanded,
} from "./message-visibility";
import { formatElapsed, resolveRunActivityExpanded, resolveRunActivitySnapshot, shouldAutoCollapseRunActivity } from "./run-activity";
import { RunStageIndicator } from "./RunStageIndicator";
import { TaskPlanCard } from "./TaskPlanCard";
import type { AgentRunStage, TaskPlanPresentation } from "./run-presentation";
import { CopyButton, copyTextToClipboard } from "./CopyButton";

import { LastTurnActionButton } from "./LastTurnActionButton";
import { resolveRevisableLastTurn } from "./last-turn-actions";
import { extractMessageStickerId, stripMessageStickerMarkers } from "./message-sticker";
import type { WeatherData } from "./weather/weather-types";
import { WeatherCard } from "./weather/WeatherCard";
import { buildAskUserQa, buildFlatRunTimeline, countRoundChangedFiles, describeToolExecution, resolveAgentRoundTitle } from "./agent-rounds";
import { TaskDelegationRow } from "./TaskDelegationRow";
import { extractFileChanges, FileChangeCard } from "./FileChangeCard";
import { ReviewPanel } from "./ReviewPanel";
import { reportChatPerfRender } from "./chat-perf-probe";
import { StreamdownMessageContent } from "./StreamdownMessageContent";
import { useScrollPinning } from "./useScrollPinning";

export interface ChatMessageItem {
  sSettlement?: import("../../../../../shared/chat-types").ChatMessage["sSettlement"]; id: string; role: "user" | "assistant" | "system";
  content: string; transientText?: string; reasoning?: string;
  reasoningBlocks?: ReasoningBlock[]; processMessages?: ProcessMessageRecord[]; agentRounds?: AgentRoundRecord[];
  taskDelegations?: TaskDelegationDisplayRecord[]; reasoningStreaming?: boolean; responseStarted?: boolean;
  streaming?: boolean; loading?: boolean; waitingForFirstEvent?: boolean;
  ttsCacheKey?: string; ttsCacheVersion?: string; sticker?: string | null;
  toolExecutions?: ToolExecutionRecord[]; runActivity?: RunActivityRecord; runStage?: AgentRunStage;
  runId?: string; taskPlan?: TaskPlanPresentation; attachments?: ChatMessageAttachment[];
  weather?: WeatherData; contextUsage?: ContextUsageSnapshot; workReadReport?: WorkReadReport;
  modelContext?: string; channelSource?: ChatMessageChannelSource;
}

export interface ChatMessageAttachment {
  name: string; kind: string; filePath?: string;
  mime?: string; previewUrl?: string; caption?: string;
  status?: string; reason?: string; imageSendMode?: "direct" | "caption";
}

interface ChatMessageListProps {
  messages: ChatMessageItem[]; conversationId?: string; mode: ConversationMode;
  preferredAddress: string; stickerSize?: "small" | "standard" | "large"; revisionBusy?: boolean;
  onEditLastUserMessage?: (messageId: string, content: string) => Promise<boolean>; onRegenerateLastResponse?: (userMessageId: string, assistantMessageId: string) => Promise<boolean>; onScrollToBottomVisibilityChange?: (visible: boolean) => void;
  onRegisterScrollToBottom?: (scroll: () => void) => void; onOpenReviewInspector?: (runId: string, fileIndex: number, filePath: string) => void; workspaceRoot?: string;
  onOpenFileLink?: (relPath: string, line?: number) => void;
}


const fireflyAvatarUrl = resolveAsset("avatars/firefly-avatar.png");
export const MessageStreamingContext = createContext(false);
export interface FileLinkEnv { workspaceRoot?: string; openFile?: (relPath: string, line?: number) => void; }
export const FileLinkContext = createContext<FileLinkEnv>({});
export interface LastTurnIds { userMessageId: string | null; assistantMessageId: string | null; }
export const LastTurnIdsContext = createContext<LastTurnIds>({ userMessageId: null, assistantMessageId: null });

export function LastTurnEditAction(props: {
  messageId?: string; content: string; disabled: boolean;
  onBeginEdit: (messageId: string, content: string) => void;
}) {
  const target = useContext(LastTurnIdsContext);
  const { messageId, content, disabled, onBeginEdit } = props;
  if (messageId && messageId === target.userMessageId) {
    return <LastTurnActionButton kind="edit" disabled={disabled} onClick={() => onBeginEdit(messageId, content)} />;
  }
  return null;
}

export function AssistantMessageFooter(props: {
  content: string; messageId?: string; streaming: boolean; conversationId?: string;
  mode: ConversationMode; preferredAddress: string; revisionBusy: boolean;
  onRegenerateLastResponse?: (userMessageId: string, assistantMessageId: string) => Promise<boolean>;
}) {
  const ids = useContext(LastTurnIdsContext);
  const text = props.content.trim();
  const regenerate = Boolean(props.messageId && props.messageId === ids.assistantMessageId);
  if (props.streaming || (!text && !regenerate)) { return null; }
  const requestAgain = () => {
    if (!ids.userMessageId || !ids.assistantMessageId) { return; }
    void props.onRegenerateLastResponse?.(ids.userMessageId, ids.assistantMessageId);
  };
  return <div className="ff-message-actions">
    {text && <CopyButton text={text} />}
    {regenerate && <LastTurnActionButton kind="regenerate" disabled={props.revisionBusy} onClick={requestAgain} />}
  </div>;
}

class MarkdownRenderBoundary extends Component<{ content: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ReactChat] Markdown/KaTeX 渲染失败，已降级为原始文本", error, info);
  }
  render(): ReactNode {
    return this.state.failed
      ? <pre className="ff-message-markdown-fallback">{this.props.content}</pre>
      : this.props.children;
  }
}

export function MarkdownContent({ content, streaming }: { content: string; streaming?: boolean }) {
  reportChatPerfRender("markdownRenders");
  const normalized = useMemo(() => normalizeModelMarkdown(content), [content]);
  return <MarkdownRenderBoundary content={normalized}>
    <MessageStreamingContext.Provider value={Boolean(streaming)}>
      <StreamdownMessageContent content={normalized} streaming={Boolean(streaming)} />
    </MessageStreamingContext.Provider>
  </MarkdownRenderBoundary>;
}

interface EnabledSticker { id: string; src: string; }
export type { EnabledSticker };
function resolveStickerUrl(id: string, stickers: readonly EnabledSticker[]): string | undefined {
  const builtin = FIREFLY_STICKERS.find((entry) => entry.id === id);
  const location = stickers.find((entry) => entry.id === id)?.src ?? (builtin ? `/stickers/${builtin.file}` : undefined);
  if (!location) { return undefined; }
  return location.startsWith("/stickers/") ? resolveAsset(location) : location;
}

const channelNameKeys: Record<ChatMessageChannelSource["channel"], string> = {
  wechat: "messageList.channelSource.wechat", feishu: "messageList.channelSource.feishu",
  qq: "messageList.channelSource.qq", qqbot: "messageList.channelSource.qqbot",
};
export function formatChannelSourceLabel(source: ChatMessageChannelSource, direction: "incoming" | "outgoing"): string {
  return direction === "outgoing" || source.chatType !== "group" ? "" : source.senderName?.trim() ?? "";
}
function ChannelSourceLabel({ source, direction }: { source: ChatMessageChannelSource; direction: "incoming" | "outgoing" }) {
  const text = formatChannelSourceLabel(source, direction);
  if (!text) { return null; }
  return <span className="ff-message__channel-source">{text}</span>;
}
export function resolveChannelConversationLabel(messages: readonly Pick<ChatMessageItem, "channelSource">[]): string | null {
  const unique = new Set(messages.map(({ channelSource }) => channelSource?.channel).filter(
    (entry): entry is ChatMessageChannelSource["channel"] => Boolean(entry),
  ));
  if (unique.size === 0) { return null; }
  const labels = Array.from(unique).map((channel) => {
    const translation = channelNameKeys[channel];
    return translation ? t(translation) : t("messageList.channelSource.unknown");
  });
  return t("messageList.channelSource.sameConversation", { channels: labels.join("、") });
}

function AssistantContent(props: {
  content: string; streaming: boolean; stickerUrl?: string;
  stickerUnavailable?: string; channelSource?: ChatMessageChannelSource;
}) {
  return <div className="ff-message__assistant-body">
    {props.channelSource && <ChannelSourceLabel source={props.channelSource} direction="outgoing" />}
    {props.content && <MarkdownContent content={props.content} streaming={props.streaming} />}
    <StickerImage src={props.stickerUrl} unavailable={props.stickerUnavailable}
      alt={t("messageList.assistantStickerAlt")} className="ff-message__sticker" />
  </div>;
}
function DotSpinner() {
  const { t } = useTranslation();
  return <span className="ff-dot-spinner" aria-label={t("messageList.loadingAria")} role="status">
    {Array.from({ length: 8 }, (_, position) => <span className="ff-dot-spinner__dot" key={position} />)}
  </span>;
}
function ModelWaitContent() {
  const { t } = useTranslation();
  return <section className="ff-model-wait" aria-label={t("messageList.modelWaitAria")}>
    <span className="ff-model-wait__art" aria-hidden="true"><DotSpinner /></span>
    <span>{t("messageList.modelWaitText")}</span>
  </section>;
}

const ignoreExpand = () => {};
export function toQuote(text: string): string {
  const lines = text.trim().split("\n");
  return lines.map((entry) => entry ? `> ${entry}` : ">").join("\n");
}
function ReasoningContent(props: { content: string; loading: boolean; expanded: boolean; onExpand: (expanded: boolean) => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(resetTimer.current), []);
  const quote = async (event: ReactMouseEvent) => {
    event.stopPropagation();
    if (!props.content.trim() || !(await copyTextToClipboard(toQuote(props.content)))) { return; }
    setCopied(true);
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopied(false), 2000);
  };
  const title = <span className="ff-message-reasoning__title">
    <span>{props.loading ? t("messageList.thinkingTitle") : t("messageList.thinkingDoneTitle")}</span>
    {props.content.trim() && <button type="button" className="ff-message-reasoning__quote" onClick={quote}>
      {copied ? t("messageList.quoteCopied") : t("messageList.copyAsQuote")}
    </button>}
  </span>;
  const icon = <span className={`ff-reasoning-status-art${props.loading ? " is-thinking" : " is-complete"}`} aria-hidden="true">
    {props.loading && <DotSpinner />}
  </span>;
  return <Think rootClassName={`ff-message-reasoning${props.loading ? " is-live" : ""}`}
    title={title} icon={icon} blink={props.loading} expanded={props.loading || props.expanded}
    onExpand={props.loading ? ignoreExpand : props.onExpand} destroyOnHidden>
    {props.content && <MarkdownContent content={props.content} streaming={props.loading} />}
  </Think>;
}
function useRunActivityNow(processing: boolean): number {
  const [clock, updateClock] = useState(() => Date.now());
  useEffect(() => {
    if (processing) {
      updateClock(Date.now());
      const interval = window.setInterval(() => updateClock(Date.now()), 1_000);
      return () => window.clearInterval(interval);
    }
  }, [processing]);
  return clock;
}
function RunActivityReasoningBlock({ block }: { block: ReasoningBlock }) {
  const live = Boolean(block.streaming);
  const [open, changeOpen] = useState(true);
  return <ReasoningContent content={block.content} loading={live} expanded={open} onExpand={changeOpen} />;
}

function AgentRoundGroup(props: {
  round: AgentRoundRecord; reasoningBlocks: ReasoningBlock[]; processMessages: ProcessMessageRecord[];
  taskDelegations: TaskDelegationDisplayRecord[]; tools: ToolExecutionRecord[]; interrupted: boolean;
}) {
  const { t } = useTranslation();
  const running = props.round.status === "running" && !props.interrupted;
  const [open, changeOpen] = useState(running);
  const previous = useRef(running);
  useEffect(() => {
    if (!previous.current && running) { changeOpen(true); }
    if (previous.current && !running) { changeOpen(false); }
    previous.current = running;
  }, [running]);
  return <section className={`ff-agent-round${running ? " is-running" : " is-complete"}`}>
    {props.processMessages.filter((entry) => entry.content.trim()).map((entry) =>
      <div className="ff-run-activity__process" key={entry.id}>
        {entry.interrupted && <div className="ff-run-activity__process-label">{t("messageList.interruptedCandidate")}</div>}
        <MarkdownContent content={entry.content} />
      </div>)}
    {props.taskDelegations.map((entry) => <TaskDelegationRow delegation={entry} key={entry.invocationId} />)}
    <button type="button" className="ff-agent-round__header" aria-expanded={open} onClick={() => changeOpen((value) => !value)}>
      <span className="ff-agent-round__title">
        {resolveAgentRoundTitle(props.round, props.tools, props.interrupted)}
        {!props.interrupted && props.round.status !== "running" && countRoundChangedFiles(props.tools) > 0 &&
          <span className="ff-agent-round__files"> · {t("messageList.roundChangedFiles", { count: countRoundChangedFiles(props.tools) })}</span>}
      </span>
      <svg className={`ff-agent-round__chevron${open ? " is-expanded" : ""}`} viewBox="0 0 16 16" aria-hidden="true">
        <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" />
      </svg>
    </button>
    {open && <div className="ff-agent-round__body">
      {props.reasoningBlocks.filter((entry) => entry.content.trim()).map((entry) => <RunActivityReasoningBlock block={entry} key={entry.id} />)}
      {props.tools.length > 0 && <ToolExecutionContent tools={props.tools} />}
    </div>}
  </section>;
}
function FlatTimelineProcess({ message }: { message: ProcessMessageRecord }) {
  const { t } = useTranslation();
  return <div className="ff-run-activity__process">
    {message.interrupted && <div className="ff-run-activity__process-label">{t("messageList.interruptedCandidate")}</div>}
    <MarkdownContent content={message.content} />
  </div>;
}

type ActivityDetailProps = {
  live?: boolean; agentRounds?: AgentRoundRecord[]; reasoningBlocks: ReasoningBlock[];
  processMessages: ProcessMessageRecord[]; taskDelegations?: TaskDelegationDisplayRecord[];
  tools: ToolExecutionRecord[]; interrupted?: boolean;
};
function liveActivityRows(input: Required<ActivityDetailProps>): ReactNode[] {
  return buildFlatRunTimeline(input).flatMap((entry) => {
    switch (entry.kind) {
      case "process": return entry.process?.content.trim() ? [<FlatTimelineProcess message={entry.process} key={entry.key} />] : [];
      case "reasoning": return entry.reasoning?.content.trim() ? [<RunActivityReasoningBlock block={entry.reasoning} key={entry.key} />] : [];
      case "tool": return entry.tool ? [<ToolExecutionContent key={entry.key} tools={[entry.tool]} />] : [];
      case "task": return entry.task ? [<TaskDelegationRow delegation={entry.task} key={entry.key} />] : [];
    }
  });
}
function completedActivityRows(input: Required<ActivityDetailProps>, translate: (key: string, options?: Record<string, unknown>) => string): ReactNode[] {
  const { agentRounds, processMessages, reasoningBlocks, taskDelegations, tools, interrupted } = input;
  if (agentRounds.length > 0) {
    return agentRounds.filter((round) =>
      processMessages.some((entry) => entry.roundId === round.id && entry.content.trim()) ||
      reasoningBlocks.some((entry) => entry.roundId === round.id && entry.content.trim()) ||
      taskDelegations.some((entry) => entry.roundId === round.id) || tools.some((entry) => entry.roundId === round.id),
    ).map((round) => <AgentRoundGroup key={round.id} round={round} interrupted={interrupted && round.status === "running"}
      processMessages={processMessages.filter((entry) => entry.roundId === round.id)}
      taskDelegations={taskDelegations.filter((entry) => entry.roundId === round.id)}
      reasoningBlocks={reasoningBlocks.filter((entry) => entry.roundId === round.id)}
      tools={tools.filter((entry) => entry.roundId === round.id)} />);
  }
  const rows: ReactNode[] = [];
  taskDelegations.forEach((entry) => {
    rows.push(<TaskDelegationRow delegation={entry} key={`task-${entry.invocationId}`} />);
  });
  for (let slot = 0; slot <= tools.length; slot += 1) {
    processMessages.filter((entry) => (entry.afterToolCount ?? 0) === slot).forEach((entry) => {
      if (!entry.content.trim()) { return; }
      rows.push(<div className="ff-run-activity__process" key={`process-${entry.id}`}>
        {entry.interrupted && <div className="ff-run-activity__process-label">{translate("messageList.interruptedCandidate")}</div>}
        <MarkdownContent content={entry.content} />
      </div>);
    });
    reasoningBlocks.filter((entry) => (entry.afterToolCount ?? 0) === slot).forEach((entry) => {
      if (entry.content.trim()) { rows.push(<RunActivityReasoningBlock key={`reasoning-${entry.id}`} block={entry} />); }
    });
    if (slot < tools.length) { rows.push(<ToolExecutionContent key={`tool-${tools[slot].id}`} tools={[tools[slot]]} />); }
  }
  return rows;
}
export function RunActivityDetail({ live = false, agentRounds = [], reasoningBlocks, processMessages, taskDelegations = [], tools, interrupted = false }: ActivityDetailProps) {
  const { t } = useTranslation();
  const input = { live, agentRounds, reasoningBlocks, processMessages, taskDelegations, tools, interrupted };
  const rows = live ? liveActivityRows(input) : completedActivityRows(input, t);
  if (rows.length === 0) { return <div className="ff-run-activity__empty">{t("messageList.organizingReply")}</div>; }
  return <div className="ff-run-activity__detail">{rows}</div>;
}

type ActivityContentProps = {
  activityId: string; activity: RunActivityRecord; reasoningBlocks: ReasoningBlock[];
  processMessages: ProcessMessageRecord[]; agentRounds: AgentRoundRecord[]; taskDelegations: TaskDelegationDisplayRecord[];
  tools: ToolExecutionRecord[]; stage?: AgentRunStage; taskPlan?: TaskPlanPresentation;
  expanded: boolean; onExpand: (expanded: boolean) => void;
};
function RunActivityContent(props: ActivityContentProps) {
  const { t } = useTranslation();
  const time = useRunActivityNow(props.activity.completedAt === undefined);
  const state = resolveRunActivitySnapshot(props.activity, time);
  const previous = useRef(state.processing);
  useEffect(() => {
    if (shouldAutoCollapseRunActivity(previous.current, state.processing, props.activity.keepExpanded)) { props.onExpand(false); }
    previous.current = state.processing;
  }, [props.activity.keepExpanded, props.onExpand, state.processing]);
  const caption = state.processing ? t("messageList.activityProcessingTitle", { elapsed: formatElapsed(state.processingMs) })
    : t("messageList.activityProcessedTitle", { elapsed: formatElapsed(state.processingMs) });
  return <section className={`ff-run-activity${state.processing ? " is-processing" : " is-complete"}`}>
    <div className="ff-run-activity__header">
      <span className="ff-run-activity__title">
        {state.processing && <span className="ff-run-activity__art" aria-hidden="true"><DotSpinner /></span>}
        <span>{caption}</span>{props.stage && <RunStageIndicator stage={props.stage} />}
      </span>
      <button type="button" className="ff-run-activity__toggle" onClick={() => props.onExpand(!props.expanded)}
        aria-expanded={props.expanded} aria-controls={`${props.activityId}-details`}
        aria-label={t(props.expanded ? "messageList.activityCollapse" : "messageList.activityExpand")}>
        <svg className={`ff-run-activity__chevron${props.expanded ? " is-expanded" : ""}`} viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" />
        </svg>
      </button>
    </div>
    {props.expanded && <div className="ff-run-activity__expanded" id={`${props.activityId}-details`}>
      {props.taskPlan && <TaskPlanCard plan={props.taskPlan} />}
      <div className="ff-run-activity__divider" />
      <RunActivityDetail live={state.processing} agentRounds={props.agentRounds} reasoningBlocks={props.reasoningBlocks}
        processMessages={props.processMessages} taskDelegations={props.taskDelegations} tools={props.tools}
        interrupted={Boolean(props.activity.keepExpanded && props.activity.completedAt !== undefined)} />
      <div className="ff-run-activity__divider" />
    </div>}
  </section>;
}
function toolChainItem(tool: ToolExecutionRecord) {
  const view = describeToolExecution(tool);
  return {
    key: tool.id,
    title: view.label,
    description: <span className="ff-tool-executions__description">
      <span className="ff-tool-executions__status">{view.statusText}</span>
      {view.detail && <code className="ff-tool-executions__detail">{view.detail}</code>}
    </span>,
    status: tool.status === "running" ? "loading" as const : tool.status === "error" ? "error" as const : "success" as const,
    blink: tool.status === "running",
    collapsible: Boolean(tool.result || tool.changes),
    content: (tool.result || tool.changes) ? <ToolResultContent tool={tool} result={tool.result} changes={tool.changes} /> : undefined,
  };
}
function ToolExecutionContent({ tools }: { tools: ToolExecutionRecord[] }) {
  const { t } = useTranslation();
  return <section className="ff-tool-executions" aria-label={t("messageList.toolExecutionsAria")}>
    <ThoughtChain rootClassName="ff-tool-executions__chain" line="dashed" items={tools.map(toolChainItem)} />
  </section>;
}
function AskUserQaContent({ rows }: { rows: string[] }) {
  const pairs = rows.map((row) => {
    const at = row.indexOf("→");
    const question = at >= 0 ? row.slice(0, at).trim() : row;
    const answer = at >= 0 ? row.slice(at + 1).trim() : "";
    return <li className="ff-ask-user-qa__row" key={row}>
      <span className="ff-ask-user-qa__question">{question}</span><span className="ff-ask-user-qa__answer">{answer}</span>
    </li>;
  });
  return <ul className="ff-ask-user-qa">{pairs}</ul>;
}
function ToolResultContent({ tool, result, changes }: { tool?: ToolExecutionRecord; result?: string; changes?: ToolFileChange[] }) {
  if (tool?.name === "ask_user") {
    const answers = buildAskUserQa(tool);
    if (answers.length > 0) { return <AskUserQaContent rows={answers} />; }
  }
  if (changes && changes.length > 0) { return <FileChangeCard changes={changes} />; }
  if (!result) { return null; }
  const diff = extractFileChanges(result);
  return diff ? <FileChangeCard changes={diff} /> : <pre className="ff-tool-executions__result">{result}</pre>;
}

function attachmentStatus(attachment: ChatMessageAttachment): string | undefined {
  switch (attachment.status) {
    case "processing": return t("messageList.attachmentProcessing");
    case "error": return attachment.reason ?? t("messageList.attachmentErrorFallback");
  }
  if (attachment.imageSendMode === "direct") { return t("messageList.attachmentDirect"); }
  return attachment.imageSendMode === "caption" && attachment.status === "done" ? t("messageList.attachmentDone") : undefined;
}
function UserAttachments({ attachments }: { attachments: ChatMessageAttachment[] }) {
  useTranslation();
  if (attachments.length === 0) { return null; }
  const children = attachments.map((attachment, position) => {
    const caption = attachmentStatus(attachment);
    const key = `${attachment.filePath ?? attachment.name}-${position}`;
    if (attachment.kind !== "image" || !(attachment.previewUrl || attachment.filePath)) {
      return <span className="ff-message__file-attachment" key={key}>{attachment.name}</span>;
    }
    return <figure className="ff-message__image-attachment" key={key}>
      <AttachmentImage attachment={attachment} />
      {caption && <figcaption className={attachment.status === "error" ? "is-error" : ""}>{caption}</figcaption>}
    </figure>;
  });
  return <div className="ff-message__attachments">{children}</div>;
}
function AttachmentImage({ attachment }: { attachment: ChatMessageAttachment }) {
  const [source, changeSource] = useState(attachment.previewUrl);
  const triedDisk = useRef(false);
  const readFromDisk = (): void => {
    if (attachment.filePath) {
      void window.chat?.getImagePreview?.(attachment.filePath).then((preview) => {
        if (preview.ok && preview.dataUrl) { changeSource(preview.dataUrl); }
      });
    }
  };
  useEffect(() => {
    changeSource(attachment.previewUrl);
    triedDisk.current = false;
    if ((!attachment.previewUrl || attachment.previewUrl.startsWith("file:")) && attachment.filePath) {
      let mounted = true;
      void window.chat?.getImagePreview?.(attachment.filePath).then((preview) => {
        if (mounted && preview.ok && preview.dataUrl) { changeSource(preview.dataUrl); }
      });
      return () => { mounted = false; };
    }
  }, [attachment.filePath, attachment.previewUrl]);
  const failed = (): void => {
    if (triedDisk.current) { return; }
    triedDisk.current = true;
    readFromDisk();
  };
  return <img src={source} alt={attachment.name} draggable={false} onError={failed} />;
}
function UserContent({ content, stickerUrl, stickerUnavailable, attachments = [], channelSource }: {
  content: string; stickerUrl?: string; stickerUnavailable?: string;
  attachments?: ChatMessageAttachment[]; channelSource?: ChatMessageChannelSource;
}) {
  const { t } = useTranslation();
  return <div className="ff-message__user-body">
    {channelSource && <ChannelSourceLabel source={channelSource} direction="incoming" />}
    <UserAttachments attachments={attachments} />{content && <MarkdownContent content={content} />}
    <StickerImage src={stickerUrl} unavailable={stickerUnavailable}
      alt={t("messageList.userStickerAlt")} className="ff-message__sticker" />
  </div>;
}
function LastUserMessageEditor(props: {
  value: string; busy: boolean; onChange: (value: string) => void; onCancel: () => void; onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") { event.preventDefault(); props.onCancel(); }
    else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); props.onSubmit(); }
  };
  return <div className="ff-last-message-editor">
    <textarea autoFocus value={props.value} disabled={props.busy} aria-label={t("messageList.editLastMessageAria")}
      onChange={(event) => props.onChange(event.target.value)} onKeyDown={keyDown} />
    <div className="ff-last-message-editor__actions">
      <button type="button" disabled={props.busy} onClick={props.onCancel}>{t("common.cancel")}</button>
      <button type="button" className="is-primary" disabled={props.busy || !props.value.trim()} onClick={props.onSubmit}>
        {t("messageList.saveAndRegenerate")}
      </button>
    </div>
  </div>;
}
function FireflyMessageAvatar() {
  const { t } = useTranslation();
  return <img className="ff-message-avatar__image" src={fireflyAvatarUrl}
    alt={t("messageList.fireflyAvatarAlt")} draggable={false} />;
}
function UserMessageAvatar({ src }: { src: string | null }) {
  const { t } = useTranslation();
  return src ? <img className="ff-message-avatar__image" src={src} alt={t("messageList.userAvatarAlt")} draggable={false} />
    : <span className="ff-message-avatar__user" role="img" aria-label={t("messageList.userAvatarAlt")}>U</span>;
}

type RoleInfo = { extraInfo?: {
  messageId?: string; stickerUrl?: string; stickerUnavailable?: string; attachments?: ChatMessageAttachment[];
  channelSource?: ChatMessageChannelSource; streaming?: boolean; reviewRunId?: string;
  reasoningId?: string; reasoning?: string; reasoningStreaming?: boolean; state?: string;
  activityId?: string; activity?: RunActivityRecord; reasoningBlocks?: ReasoningBlock[];
  processMessages?: ProcessMessageRecord[]; agentRounds?: AgentRoundRecord[]; taskDelegations?: TaskDelegationDisplayRecord[];
  tools?: ToolExecutionRecord[]; runStage?: AgentRunStage; taskPlan?: TaskPlanPresentation; weather?: WeatherData; runId?: string;
} };
function plainRole(name: string) {
  return { placement: "start" as const, variant: "borderless" as const, avatar: null, rootClassName: `ff-message ff-message--${name}` };
}
function createRoles(
  userAvatarUrl: string | null, conversationId: string | undefined, mode: ConversationMode, preferredAddress: string,
  editingMessageId: string | null, editDraft: string, revisionBusy: boolean,
  onBeginEdit: (messageId: string, content: string) => void, onEditDraftChange: (value: string) => void,
  onCancelEdit: () => void, onSubmitEdit: () => void,
  onRegenerateLastResponse: ((userMessageId: string, assistantMessageId: string) => Promise<boolean>) | undefined,
  reasoningExpanded: Readonly<Record<string, boolean>>, onReasoningExpand: (id: string, expanded: boolean) => void,
  onOpenReviewInspector?: (runId: string, fileIndex: number, filePath: string) => void,
) {
  const user = {
    placement: "end" as const, variant: "filled" as const, rootClassName: "ff-message ff-message--user",
    avatar: <UserMessageAvatar src={userAvatarUrl} />,
    contentRender: (content: string, info: RoleInfo) => {
      if (info.extraInfo?.messageId === editingMessageId) {
        return <LastUserMessageEditor value={editDraft} busy={revisionBusy} onChange={onEditDraftChange}
          onCancel={onCancelEdit} onSubmit={onSubmitEdit} />;
      }
      return <UserContent content={content} stickerUrl={info.extraInfo?.stickerUrl} stickerUnavailable={info.extraInfo?.stickerUnavailable}
        attachments={info.extraInfo?.attachments} channelSource={info.extraInfo?.channelSource} />;
    },
    footer: (content: string, info: RoleInfo) => {
      const copyable = content.replace(/\[sticker:[^\]]+\]/g, "").trim();
      const id = info.extraInfo?.messageId;
      if (!copyable || id === editingMessageId) { return null; }
      return <div className="ff-message-actions">
        <LastTurnEditAction messageId={id} content={copyable} disabled={revisionBusy} onBeginEdit={onBeginEdit} />
        <CopyButton text={copyable} />
      </div>;
    },
  };
  const assistant = {
    placement: "start" as const, variant: "filled" as const, rootClassName: "ff-message ff-message--assistant",
    avatar: <FireflyMessageAvatar />,
    contentRender: (content: string, info: RoleInfo) => <>
      <AssistantContent content={content} streaming={Boolean(info.extraInfo?.streaming)} stickerUrl={info.extraInfo?.stickerUrl}
        stickerUnavailable={info.extraInfo?.stickerUnavailable} channelSource={info.extraInfo?.channelSource} />
      {info.extraInfo?.reviewRunId && <ReviewPanel runId={info.extraInfo.reviewRunId} onOpenInspector={onOpenReviewInspector} />}
    </>,
    footer: (content: string, info: RoleInfo) => <AssistantMessageFooter content={content} messageId={info.extraInfo?.messageId}
      streaming={Boolean(info.extraInfo?.streaming)} conversationId={conversationId} mode={mode} preferredAddress={preferredAddress}
      revisionBusy={revisionBusy} onRegenerateLastResponse={onRegenerateLastResponse} />,
  };
  const reasoning = {
    placement: "start" as const, variant: "borderless" as const, rootClassName: "ff-message ff-message--reasoning",
    contentRender: (_content: string, info: RoleInfo) => <ReasoningContent content={info.extraInfo?.reasoning ?? ""}
      loading={Boolean(info.extraInfo?.reasoningStreaming)}
      expanded={info.extraInfo?.reasoningId ? resolveReasoningExpanded(reasoningExpanded, info.extraInfo.reasoningId) : false}
      onExpand={(open) => { if (info.extraInfo?.reasoningId) { onReasoningExpand(info.extraInfo.reasoningId, open); } }} />,
  };
  const sAudit = {
    placement: "start" as const, variant: "borderless" as const,
    contentRender: (content: string, info: RoleInfo) => <details open>
      <summary>{t(`messageList.sSettlement${info.extraInfo?.state ?? "unknown"}`)}</summary><MarkdownContent content={content} />
    </details>,
  };
  const activity = {
    ...plainRole("activity"),
    contentRender: (_content: string, info: RoleInfo) => {
      const id = info.extraInfo?.activityId;
      const record = info.extraInfo?.activity;
      if (!id || !record) { return null; }
      return <RunActivityContent activityId={id} activity={record} reasoningBlocks={info.extraInfo?.reasoningBlocks ?? []}
        processMessages={info.extraInfo?.processMessages ?? []} agentRounds={info.extraInfo?.agentRounds ?? []}
        taskDelegations={info.extraInfo?.taskDelegations ?? []} tools={info.extraInfo?.tools ?? []}
        stage={info.extraInfo?.runStage} taskPlan={info.extraInfo?.taskPlan}
        expanded={resolveRunActivityExpanded(reasoningExpanded, id, record)} onExpand={(open) => onReasoningExpand(id, open)} />;
    },
  };
  const tool = { ...plainRole("tool"), contentRender: (_content: string, info: RoleInfo) =>
    info.extraInfo?.tools?.length ? <ToolExecutionContent tools={info.extraInfo.tools} /> : null };
  const waiting = { ...plainRole("waiting"), contentRender: () => <ModelWaitContent /> };
  const weather = { ...plainRole("weather"), contentRender: (_content: string, info: RoleInfo) =>
    info.extraInfo?.weather ? <WeatherCard data={info.extraInfo.weather} /> : null };
  const review = { ...plainRole("review"), contentRender: (_content: string, info: RoleInfo) =>
    info.extraInfo?.runId ? <ReviewPanel runId={info.extraInfo.runId} onOpenInspector={onOpenReviewInspector} /> : null };
  const system = { placement: "start" as const, variant: "borderless" as const, rootClassName: "ff-message ff-message--system" };
  return { user, assistant, reasoning, sAudit, activity, tool, waiting, weather, review, system };
}
function unavailableSticker(id: string | null | undefined, stickers: readonly EnabledSticker[]): string | undefined {
  if (id && isRetiredStickerId(id)) { return "表情包已下架"; }
  return id && !resolveStickerUrl(id, stickers) ? "表情包不可用" : undefined;
}
function nonAssistantItem(message: ChatMessageItem, stickers: readonly EnabledSticker[]): BubbleItemType {
  const id = extractMessageStickerId(message.content, message.sticker);
  return {
    key: message.id, role: message.role, content: stripMessageStickerMarkers(message.content),
    extraInfo: {
      stickerUrl: id ? resolveStickerUrl(id, stickers) : undefined,
      stickerUnavailable: unavailableSticker(id, stickers),
      attachments: message.attachments, messageId: message.id, channelSource: message.channelSource,
    },
  };
}
function appendMessageActivity(items: BubbleItemType[], message: ChatMessageItem, blocks: ReasoningBlock[], tools: ToolExecutionRecord[], visible: boolean): void {
  if (!visible) { return; }
  items.push({
    key: `${message.id}-activity`,
    role: "activity",
    content: "", avatar: createElement(FireflyMessageAvatar),
    extraInfo: {
      activityId: `${message.id}-activity`, activity: message.runActivity, reasoningBlocks: blocks,
      processMessages: message.processMessages ?? [], agentRounds: message.agentRounds ?? [],
      taskDelegations: message.taskDelegations ?? [], tools, runStage: message.runStage, taskPlan: message.taskPlan,
    },
  });
}
function appendMessageSteps(items: BubbleItemType[], message: ChatMessageItem, blocks: ReasoningBlock[], tools: ToolExecutionRecord[]): void {
  for (let index = 0; index <= tools.length; index += 1) {
    blocks.filter((block) => (block.afterToolCount ?? 0) === index).forEach((block) => {
      items.push({
        key: `${message.id}-reasoning-${block.id}`, role: "reasoning", content: "",
        extraInfo: { reasoningId: block.id, reasoning: block.content, reasoningStreaming: block.streaming },
      });
    });
    if (index < tools.length) {
      items.push({
        key: `${message.id}-tool-${tools[index].id}`,
        role: "tool", content: "", extraInfo: { tools: [tools[index]] },
      });
    }
  }
}
function appendMessageAnswer(items: BubbleItemType[], message: ChatMessageItem, stickers: readonly EnabledSticker[], hideAvatar: boolean, reviewReady: boolean): void {
  items.push({
    key: message.id, role: "assistant", content: message.transientText ?? message.content, streaming: message.streaming,
    ...(hideAvatar ? { rootClassName: "ff-message ff-message--assistant ff-message--assistant-run" } : {}),
    extraInfo: {
      messageId: message.id, streaming: message.streaming, ttsCacheKey: message.ttsCacheKey,
      stickerUrl: message.sticker ? resolveStickerUrl(message.sticker, stickers) : undefined,
      stickerUnavailable: unavailableSticker(message.sticker, stickers), channelSource: message.channelSource,
      ...(reviewReady ? { reviewRunId: message.runId } : {}),
    },
  });
}
function appendReadReport(items: BubbleItemType[], message: ChatMessageItem): void {
  if (!message.workReadReport || message.streaming || message.loading) { return; }
  const report = message.workReadReport;
  const lines = [`文件读取：${t(`workRead.${report.status}`)}`,
    ...report.files.map((file) => `${file.name}：${t(`workRead.${file.status}`)}（${file.coveredLines}/${file.requiredLines} 行；全文 ${file.totalLines} 行）`)];
  items.push({ key: `${message.id}-read-report`, role: "system", content: lines.join("\n") });
}
function convertMessage(message: ChatMessageItem, enabledStickers: readonly EnabledSticker[]): readonly BubbleItemType[] {
  if (message.role !== "assistant") { return [nonAssistantItem(message, enabledStickers)]; }
  const items: BubbleItemType[] = [];
  const stages = assistantRenderStages(message);
  if (message.waitingForFirstEvent && !message.runActivity) {
    items.push({ key: `${message.id}-waiting`, role: "waiting", content: "" });
  }
  const blocks: ReasoningBlock[] = message.reasoningBlocks?.length ? message.reasoningBlocks
    : stages.includes("reasoning") ? [{ id: `${message.id}-legacy`, content: message.reasoning ?? "", streaming: message.reasoningStreaming }] : [];
  const tools = message.toolExecutions ?? [];
  const hasProcess = (message.processMessages ?? []).some((entry) => entry.content.trim()) || tools.length > 0
    || (message.taskDelegations ?? []).length > 0 || blocks.some((entry) => entry.content.trim());
  const processing = message.runActivity?.completedAt === undefined;
  const activityVisible = Boolean(message.runActivity) && (processing || hasProcess);
  if (message.runActivity) { appendMessageActivity(items, message, blocks, tools, activityVisible); }
  else { appendMessageSteps(items, message, blocks, tools); }
  if (message.weather) { items.push({ key: `${message.id}-weather`, role: "weather", content: "", extraInfo: { weather: message.weather } }); }
  if (message.sSettlement && message.sSettlement.state !== "success") {
    items.push({ key: `${message.id}-s-audit`, role: "sAudit", content: message.sSettlement.originalText, extraInfo: { state: message.sSettlement.state } });
  }
  const reviewReady = Boolean(message.runId && !message.streaming && !message.loading);
  const answerShown = stages.includes("assistant") && (!message.sSettlement || message.sSettlement.state === "success");
  if (answerShown) { appendMessageAnswer(items, message, enabledStickers, activityVisible, reviewReady); }
  if (reviewReady && !answerShown) {
    items.push({
      key: `${message.id}-review`, role: "review", content: "", avatar: createElement(FireflyMessageAvatar),
      rootClassName: "ff-message ff-message--review ff-message--review-run", extraInfo: { runId: message.runId },
    });
  }
  appendReadReport(items, message);
  return items;
}
export function createMessageItems(messages: ChatMessageItem[], enabledStickers: EnabledSticker[]): BubbleItemType[] {
  const items = messages.flatMap((entry) => convertMessage(entry, enabledStickers));
  return items;
}
export interface MessageItemsCacheState {
  stickers: readonly EnabledSticker[]; byMessage: WeakMap<ChatMessageItem, readonly BubbleItemType[]>;
}
export function assembleMessageItems(messages: readonly ChatMessageItem[], stickers: readonly EnabledSticker[], cache: MessageItemsCacheState | null): { items: BubbleItemType[]; cache: MessageItemsCacheState } {
  const current = cache && cache.stickers === stickers ? cache
    : { stickers, byMessage: new WeakMap<ChatMessageItem, readonly BubbleItemType[]>() };
  const output: BubbleItemType[] = [];
  for (const message of messages) {
    let rows = current.byMessage.get(message);
    if (rows === undefined) { rows = convertMessage(message, stickers); current.byMessage.set(message, rows); }
    for (const row of rows) { output.push(row); }
  }
  return { items: output, cache: current };
}

export function ChatMessageList({
  messages, conversationId, mode, preferredAddress, stickerSize = "standard", revisionBusy = false,
  onEditLastUserMessage, onRegenerateLastResponse, onScrollToBottomVisibilityChange, onRegisterScrollToBottom,
  onOpenReviewInspector, workspaceRoot, onOpenFileLink,
}: ChatMessageListProps) {
  reportChatPerfRender("listRenders");
  const avatar = useUserAvatar();
  const [stickers, changeStickers] = useState<EnabledSticker[]>([]);
  const [expanded, changeExpanded] = useState<Record<string, boolean>>({});
  const [editingId, changeEditingId] = useState<string | null>(null);
  const [draft, changeDraft] = useState("");
  const revisable = useMemo(() => resolveRevisableLastTurn(messages, mode), [messages, mode]);
  const turnIds = useMemo<LastTurnIds>(() => ({
    userMessageId: revisable?.userMessageId ?? null, assistantMessageId: revisable?.assistantMessageId ?? null,
  }), [revisable?.userMessageId, revisable?.assistantMessageId]);
  const expandReasoning = useCallback((id: string, open: boolean) => {
    changeExpanded((previous) => updateReasoningExpanded(previous, id, open));
  }, []);
  const beginEdit = useCallback((id: string, text: string) => { changeEditingId(id); changeDraft(text); }, []);
  const cancelEdit = useCallback(() => {
    if (revisionBusy) { return; }
    changeEditingId(null); changeDraft("");
  }, [revisionBusy]);
  const submitEdit = useCallback(() => {
    if (!editingId || !draft.trim() || !onEditLastUserMessage || revisionBusy) { return; }
    void onEditLastUserMessage(editingId, draft.trim()).then((accepted) => {
      if (accepted) { changeEditingId(null); changeDraft(""); }
    });
  }, [draft, editingId, onEditLastUserMessage, revisionBusy]);
  const { containerRef, onScroll, scrollToBottom, markUserScroll } = useScrollPinning(onScrollToBottomVisibilityChange);
  useEffect(() => { onRegisterScrollToBottom?.(scrollToBottom); }, [onRegisterScrollToBottom, scrollToBottom]);
  useEffect(() => {
    scrollToBottom("auto");
    const repeat = window.setTimeout(() => scrollToBottom("auto"), 100);
    return () => window.clearTimeout(repeat);
  }, [conversationId, scrollToBottom]);
  const roles = useMemo(() => createRoles(avatar, conversationId, mode, preferredAddress, editingId, draft, revisionBusy,
    beginEdit, changeDraft, cancelEdit, submitEdit, onRegenerateLastResponse, expanded, expandReasoning, onOpenReviewInspector),
    [beginEdit, cancelEdit, conversationId, draft, editingId, mode, onOpenReviewInspector, expandReasoning,
      onRegenerateLastResponse, preferredAddress, expanded, revisionBusy, submitEdit, avatar]);
  useEffect(() => {
    if (editingId && editingId !== revisable?.userMessageId) { changeEditingId(null); changeDraft(""); }
  }, [editingId, revisable?.userMessageId]);
  useEffect(() => {
    let mounted = true;
    void (window.stickerManager?.getConfig?.() ?? window.chat?.getEnabledStickers?.())?.then((next) => {
      if (mounted) { changeStickers(next); }
    }).catch(() => { if (mounted) { changeStickers([]); } });
    return () => { mounted = false; };
  }, []);
  const cacheRef = useRef<MessageItemsCacheState | null>(null);
  const items = useMemo(() => {
    const batch = assembleMessageItems(messages, stickers, cacheRef.current);
    cacheRef.current = batch.cache;
    return batch.items;
  }, [messages, stickers]);
  const channelLabel = resolveChannelConversationLabel(messages);
  const fileEnvironment = useMemo<FileLinkEnv>(() => ({ workspaceRoot, openFile: onOpenFileLink }), [workspaceRoot, onOpenFileLink]);
  return <FileLinkContext.Provider value={fileEnvironment}>
    <LastTurnIdsContext.Provider value={turnIds}>
      <div className="ff-message-scroll">
        <div ref={containerRef} className={`ff-message-list ff-message-list--stickers-${stickerSize}`} aria-live="polite" onScroll={onScroll}>
          {channelLabel && <div className="ff-message-list__channel-context" role="note" aria-label={channelLabel}>
            <span className="ff-message-list__channel-dot" aria-hidden="true" /><span>{channelLabel}</span>
          </div>}
          <Bubble.List items={items} role={roles} autoScroll />
        </div>
        <ScrollPill target={containerRef} panel=".ff-workspace-body" onUserScroll={markUserScroll} />
      </div>
    </LastTurnIdsContext.Provider>
  </FileLinkContext.Provider>;
}
