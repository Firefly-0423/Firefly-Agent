import type {BoundSourceRef} from '../../shared/memory-contracts';
import type {ContextMessage,SourceDependency,TranscriptDependency} from '../memory-context/context-contracts';
import type {RecallDependency} from '../memory-recall/recall-contracts';
import type {HistoryTemporalResult} from './history-temporal';
export interface HistorySession {providerId:string;sessionId:string}
export interface HistoryPartition {actorKey:string;sessions:HistorySession[]}
export interface HistoryVector {identity:string;values:number[]}
export interface HistoryMessage extends ContextMessage {id:string;occurredAt:number|null;timeZone:string|null;sourceRef?:BoundSourceRef}
export interface HistoryDocument {id:string;incarnation:string;revision:number;origin:'canonical'|'synthetic-import';sourceDeps:SourceDependency[];messages:HistoryMessage[];vector:HistoryVector|null;transcriptRef?:TranscriptDependency;classification?:ReadonlyHistoryClassification;provenance?:ReadonlyHistoryProvenance[]}
export interface StoredHistory extends HistoryDocument {actorKey:string;providerId:string;sessionId:string;generation:number;digest:string;state:'live'|'deleted'}
/** windowTurns：词法排序按几轮一个窗口计分，0 关闭；recencyAlpha：相关度接近时新内容优先的力度，0 关闭；半衰期以天计。 */
export interface HistorySettings {version:string;limit:number;candidateLimit:number;rrfK:number;mmrLambda:number;maxTotalChars:number;maxExcerptChars:number;maxIndexDocuments:number;maxIndexBytes:number;windowTurns:number;recencyAlpha:number;recencyHalfLifeDays:number}
export const DEFAULT_HISTORY_SETTINGS:Readonly<HistorySettings>=Object.freeze({version:'history-settings-v2',limit:8,candidateLimit:50,rrfK:60,mmrLambda:.7,maxTotalChars:16000,maxExcerptChars:6000,maxIndexDocuments:512,maxIndexBytes:8388608,windowTurns:2,recencyAlpha:.1,recencyHalfLifeDays:30});
/** An excerpt names the contiguous message range [start,end) of a longer stored document. `digest` binds the full-document digest, the range, the total message count and the quoted messages, so a stale or swapped range cannot be replayed. */
export interface HistoryExcerptRef {version:'history-excerpt-v1';start:number;end:number;total:number;digest:string}
/** `digest` is always the digest of the FULL stored document; `excerpt`, when present, narrows the dependency to that message range of it. */
export interface HistoryDependency {documentId:string;providerId:string;sessionId:string;incarnation:string;revision:number;digest:string;generation:number;partition:HistoryPartition;indexVersion:string;tokenizerVersion:string;rankingVersion:string;recallDeps:RecallDependency[];excerpt?:HistoryExcerptRef}
/** With `excerpt`, `messages` and `provenance` hold ONLY that range of the stored document (re-sliced from the stored copy, never cut mid-message); every other field, `digest` included, describes the full document. */
export interface HistoryHitDocument extends StoredHistory {excerpt?:HistoryExcerptRef}
export interface HistoryHit {document:HistoryHitDocument;dependency:HistoryDependency;score:number}
/** 预算丢弃的计数，只有数字，不含任何正文、标识或查询内容。用来判断"单份文档超限"在真实使用中有多常见。 */
export const HISTORY_BUDGET_SIZE_BUCKETS=['le-6k','6k-12k','12k-24k','24k-48k','gt-48k'] as const;
export type HistoryBudgetSizeBucket=typeof HISTORY_BUDGET_SIZE_BUCKETS[number];
export interface HistoryBudgetStats {
 /** 排序后进入预算环节的文档数。 */ ranked:number;returned:number;
 /** 单份字符数超过 maxExcerptChars 而被丢弃。 */ droppedOversized:number;
 /** 单份不超限、但总预算 maxTotalChars 已用完而被丢弃。 */ droppedOverTotal:number;
 /** 单份超限、但最佳窗口（连同必须成组的工具调用）放得下，因而以摘录返回的份数；已计入 returned。 */ excerpted:number;
 /** 仍被丢弃的超限文档里，最佳窗口本身（不计工具成组约束）放得下 maxExcerptChars 的份数：被工具成组或剩余总预算挡住的上限估计。 */ oversizedExcerptable:number;
 /** 被丢弃文档按字符数分段计数。 */ droppedSizes:Record<HistoryBudgetSizeBucket,number>;
}
export interface HistoryResult {status:'ok'|'index-budget-exhausted'|'excerpt-budget-exhausted';hits:HistoryHit[];diversity:'vector-mmr'|'lexical-dedup';settingsVersion:string;temporal?:HistoryTemporalResult;budget?:HistoryBudgetStats}
export interface HistoryTransport {historyCommand(command:unknown):Promise<unknown>}

export type ReadonlyHistoryClassification='raw-history'|'legacy-derived-unverified'|'unverified';
/** Constructed only by a Main caller after actor/scope authorization; strings do not grant authority. */
export interface ReadonlyHistoryScope {root:string;actorKey:string;scopeKey:string;sessions:HistorySession[]}
export interface ReadonlyHistoryProvenance {
 originalId:string;seq:number|null;turnId:string|null;revision:number|null;incarnation:string;digest:string;
 span:{start:number;end:number};originalRole:ContextMessage['role'];occurredAt:number|null;timeZone:string|null;active:boolean;
 format:'transcript-v1'|'chat-session-v1';providerId:string;sessionId:string;field?:'modelContext';
}
export interface ReadonlyHistoryRecord {document:HistoryDocument;classification:ReadonlyHistoryClassification;provenance:ReadonlyHistoryProvenance[]}
export interface ReadonlyHistorySelectionHead {providerId:string;sessionId:string;incarnation:string;maxSeq:number;checkpointThroughSeq:number;completeTail:boolean}
export interface ReadonlyHistoryReadResult {selectionHeads:ReadonlyHistorySelectionHead[];documents:ReadonlyHistoryRecord[];coverage:'complete'|'partial';diagnostics:string[]}

/** Explicit immutable-by-value input for the pure parser; never a filesystem or Worker capability. */
export interface ReadonlyHistoryBytes {
 providerId:string;sessionId:string;incarnation:string;
 transcript:Uint8Array|null;snapshot:Uint8Array|null;chat:Uint8Array|null;
}
