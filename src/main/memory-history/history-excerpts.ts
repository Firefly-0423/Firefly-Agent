// 超长文档的摘录：命中后只返回"最佳窗口 + 邻近上下文"这一段连续消息，而不是整份文档。
// 本文件只有纯函数：选择区间、切片、计算与校验摘录校验值。授权、来源、遗忘和转录头的检查仍然对整份文档做；
// 摘录永远由调用方对照权威文档重新切出，这里不接受任何来自排序阶段或外部传入的摘录正文。
import {createHash} from 'node:crypto';
import {canonicalJson} from '../memory-core/repository-types';
import {validateUnit} from '../memory-context/token-budget';
import type {HistoryExcerptRef} from './history-contracts';

export const HISTORY_EXCERPT_VERSION='history-excerpt-v1' as const;
/** 最佳窗口两侧各最多再扩几个窗口。评测默认值，没有单独调过。 */
export const HISTORY_EXCERPT_CONTEXT_WINDOWS=1;

export interface ExcerptRange {start: number; end: number}

export interface ExcerptInput {
  /** 每条消息计入预算的字符数（`historyMessageChars`）。 */
  sizes: ReadonlyArray<number>;
  /** 排序窗口的轮数，必须与排序时的 `toWindows` 一致。 */
  windowTurns: number;
  /** 排序得到的最佳窗口下标。 */
  bestUnit: number;
  /** 摘录的字符预算（含最佳窗口本身）。 */
  maxChars: number;
  /** 最佳窗口两侧各最多再扩几个窗口。 */
  contextWindows: number;
  /** 不可拆开的消息区间（工具调用与其结果）。摘录的起止都不能落在某个区间内部。 */
  groups?: ReadonlyArray<ExcerptRange>;
}

const isCount = (n: number) => Number.isSafeInteger(n) && n >= 0;

interface ToolShape {role: string; toolCallIds?: ReadonlyArray<string>; toolCallId?: string; toolCalls?: ReadonlyArray<{id: string}>}

/** 助手的工具调用与它的全部工具结果必须在同一份摘录里：从调用到最后一条结果是一个不可拆开的区间；重叠的区间合并。 */
export function atomicGroups(messages: ReadonlyArray<ToolShape>): ExcerptRange[] {
  const lastResult = new Map<string, number>();
  messages.forEach((m, i) => {
    if (m.toolCallId !== undefined) lastResult.set(m.toolCallId, Math.max(lastResult.get(m.toolCallId) ?? -1, i));
  });
  const spans: ExcerptRange[] = [];
  messages.forEach((m, i) => {
    const ids = [...(m.toolCallIds ?? []), ...(m.toolCalls?.map((c) => c.id) ?? [])];
    let end = i + 1;
    for (const id of ids) {
      const at = lastResult.get(id);
      if (at !== undefined && at > i) end = Math.max(end, at + 1);
    }
    if (end > i + 1) spans.push({start: i, end});
  });
  const merged: ExcerptRange[] = [];
  for (const span of spans.sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && span.start < last.end) last.end = Math.max(last.end, span.end);
    else merged.push({...span});
  }
  return merged;
}

/**
 * 以最佳窗口为中心，在预算内向两侧交替各扩一个窗口（先前后，每侧最多 `contextWindows` 个）。
 * 任何扩展都先吸收被切到的工具组，再核对预算；最佳窗口（连同它必须带上的工具组）放不下、或输入不合法时返回 null，
 * 宁可不返回，也不截断消息或拆开工具调用。
 */
export function selectExcerpt(input: ExcerptInput): ExcerptRange | null {
  const {sizes, windowTurns: turns, bestUnit, maxChars, contextWindows, groups = []} = input;
  const n = sizes.length;
  if (n === 0 || !Number.isSafeInteger(turns) || turns <= 0 || !isCount(bestUnit) || !isCount(contextWindows)
    || !Number.isFinite(maxChars) || maxChars <= 0 || sizes.some((s) => !Number.isFinite(s) || s < 0)
    || groups.some((g) => !isCount(g.start) || !Number.isSafeInteger(g.end) || g.end <= g.start || g.end > n)) return null;
  if (bestUnit >= Math.ceil(n / turns)) return null;
  const sum = (r: ExcerptRange) => {
    let total = 0;
    for (let i = r.start; i < r.end; i++) total += sizes[i];
    return total;
  };
  const snap = (r: ExcerptRange): ExcerptRange => {
    let {start, end} = r;
    for (let changed = true; changed;) {
      changed = false;
      for (const g of groups) {
        if (g.start < end && g.end > start && (g.start < start || g.end > end)) {
          start = Math.min(start, g.start);
          end = Math.max(end, g.end);
          changed = true;
        }
      }
    }
    return {start, end};
  };
  const first = bestUnit * turns;
  let range = snap({start: first, end: Math.min(n, first + turns)});
  if (sum(range) > maxChars) return null;
  let beforeOpen = true;
  let afterOpen = true;
  for (let step = 0; step < contextWindows && (beforeOpen || afterOpen); step++) {
    if (beforeOpen) {
      const next = range.start > 0 ? snap({start: Math.max(0, range.start - turns), end: range.end}) : null;
      if (next && sum(next) <= maxChars) range = next;
      else beforeOpen = false;
    }
    if (afterOpen) {
      const next = range.end < n ? snap({start: range.start, end: Math.min(n, range.end + turns)}) : null;
      if (next && sum(next) <= maxChars) range = next;
      else afterOpen = false;
    }
  }
  return range;
}

/**
 * 最后一道闸：把区间内的消息按合并校验同一套规则（`validateUnit`）再验一遍——没有调用的工具结果、缺结果的工具调用都会被拒绝。
 * 区间必须落在文档内且非空；不依赖 `atomicGroups` 的结果，两者各自独立。
 */
export function excerptToolSafe(messages: ReadonlyArray<unknown>, range: ExcerptRange): boolean {
  if (!isCount(range.start) || !Number.isSafeInteger(range.end) || range.end <= range.start || range.end > messages.length) return false;
  try {
    validateUnit({id: 'excerpt', kind: 'summary', messages: messages.slice(range.start, range.end) as never});
    return true;
  } catch {
    return false;
  }
}

interface ExcerptSource {messages: ReadonlyArray<unknown>; provenance?: ReadonlyArray<unknown>}

/** 按同一组下标切出消息和与之一一对应的 provenance。 */
export function sliceExcerpt<D extends ExcerptSource>(doc: D, range: ExcerptRange): {messages: D['messages']; provenance?: NonNullable<D['provenance']>} {
  return {
    messages: doc.messages.slice(range.start, range.end) as D['messages'],
    ...(doc.provenance ? {provenance: doc.provenance.slice(range.start, range.end) as NonNullable<D['provenance']>} : {}),
  };
}

const digestOfSlice = (documentDigest: string, total: number, range: ExcerptRange, slice: ExcerptSource): string =>
  createHash('sha256').update(canonicalJson({
    version: HISTORY_EXCERPT_VERSION, documentDigest, total, start: range.start, end: range.end, messages: slice.messages, ...(slice.provenance ? {provenance: slice.provenance} : {}),
  })).digest('hex');

/** 摘录校验值：绑定整文校验值、区间、总条数和区间内的消息与 provenance。它与整文校验值含义不同，不能互相替代。 */
export function excerptDigest(documentDigest: string, doc: ExcerptSource, range: ExcerptRange): string {
  return digestOfSlice(documentDigest, doc.messages.length, range, sliceExcerpt(doc, range));
}

/** 由权威文档生成摘录引用。 */
export function excerptRef(documentDigest: string, doc: ExcerptSource, range: ExcerptRange): HistoryExcerptRef {
  return {version: HISTORY_EXCERPT_VERSION, start: range.start, end: range.end, total: doc.messages.length, digest: excerptDigest(documentDigest, doc, range)};
}

/** 引用本身是否合法：版本已知、区间是整数、不空、落在总条数内且不是整份文档，校验值是 64 位十六进制。 */
function wellFormed(ref: HistoryExcerptRef): boolean {
  if (!ref || typeof ref !== 'object' || ref.version !== HISTORY_EXCERPT_VERSION) return false;
  const {start, end, total} = ref;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !Number.isSafeInteger(total)) return false;
  if (start < 0 || end <= start || end > total || (start === 0 && end === total)) return false;
  return typeof ref.digest === 'string' && /^[a-f0-9]{64}$/.test(ref.digest);
}

/** 摘录引用是否与权威文档一致：引用合法、总条数一致、校验值能由文档重新算出。 */
export function verifyExcerpt(doc: ExcerptSource, documentDigest: string, ref: HistoryExcerptRef): boolean {
  if (!wellFormed(ref) || ref.total !== doc.messages.length) return false;
  return ref.digest === excerptDigest(documentDigest, doc, {start: ref.start, end: ref.end});
}

/**
 * 只持有切片时的校验（Main 端拿不到整份文档）：切片条数与区间一致，校验值由切片内容、整文校验值和区间重新算出。
 * 这能发现区间被换、正文被改、整文校验值被换；"切片是否真的来自当前存储的文档"仍由 Worker 端的 `verifyExcerpt` 判定。
 */
export function verifyExcerptSlice(slice: ExcerptSource, documentDigest: string, ref: HistoryExcerptRef): boolean {
  if (!wellFormed(ref) || slice.messages.length !== ref.end - ref.start) return false;
  if (slice.provenance && slice.provenance.length !== slice.messages.length) return false;
  return ref.digest === digestOfSlice(documentDigest, ref.total, {start: ref.start, end: ref.end}, slice);
}
