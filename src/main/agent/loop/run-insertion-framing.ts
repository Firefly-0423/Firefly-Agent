// 运行中插入的补充交给模型时套用的固定中文说明（负责人已定的措辞）。
// 只在两个边界使用：已交付的插入进入运行循环时、会话记录物化成上下文时。
// 聊天历史与会话记录一律保存用户原文；不按正文前缀判断是否已经加过说明。

import type { TranscriptEntry } from "../../conversation/transcript/conversation-transcript-types";

export const RUN_INSERTION_FRAME_HEAD = "【运行中补充】用户在你执行任务的过程中补充了以下内容：";
export const RUN_INSERTION_FRAME_TAIL = "请先检查已经完成的部分是否需要按这条补充调整，没有问题就补全之前的工作，然后接着做。";

/** Wraps the user's original text unchanged; the role stays `user`, so this grants no extra authority. */
export function frameRunInsertion(text: string): string {
  return `${RUN_INSERTION_FRAME_HEAD}\n${text}\n${RUN_INSERTION_FRAME_TAIL}`;
}

/** A transcript user entry with a non-empty `runId` was inserted into that run (#96); ordinary user entries carry none. */
export function isRunInsertionEntry(entry: TranscriptEntry): boolean {
  return entry.kind === "user" && typeof entry.runId === "string" && entry.runId.length > 0;
}
