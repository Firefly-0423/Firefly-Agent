// M2a：影子记录的存储契约。记录只追加、加密保存，来源失效即不可见；开关、清空版本、每日用量都持久化。
import type {BoundSourceRef} from '../../shared/memory-contracts';
import {SHADOW_DROP_REASONS,type ShadowCandidate} from './shadow-contracts';

export const SHADOW_STORE_LIMITS=Object.freeze({defaultDailyCap:50,maxDailyCap:1000,maxRecordsPerActor:5000,statsRetentionDays:90});

/** 当天停止的原因：额度不足或被限流。第二天自动恢复。 */
export type ShadowStopReason='quota'|'rate-limit';
export const SHADOW_STOP_REASONS:ReadonlyArray<ShadowStopReason>=['quota','rate-limit'];

/** 预占或写回被拒绝的原因。 */
export type ShadowRefusal='disabled'|'generation-changed'|'source-unavailable'|'duplicate'|'cap-reached'|'stopped'|'not-reserved'|'storage-full';
export const SHADOW_REFUSALS:ReadonlyArray<ShadowRefusal>=['disabled','generation-changed','source-unavailable','duplicate','cap-reached','stopped','not-reserved','storage-full'];

/**
 * 每日统计里允许出现的计数名。只有数字，不含任何内容。
 * skip: 没有发送；error: 发送了但失败；cancel: 排队或在途时取消；drop: 校验丢弃；refuse/discard: 预占或写回被拒。
 */
export const SHADOW_COUNTERS=Object.freeze([
 'sent','candidates','downgraded',
 'skip:empty','skip:too-long','skip:secret','skip:no-output-limit',
 'error:timeout','error:network','error:http','error:quota','error:rate-limit',
 'cancel:turn-failed','cancel:profile-changed','cancel:disabled','cancel:cleared','cancel:source-changed','cancel:queue-full','cancel:restart',
 ...SHADOW_DROP_REASONS.map(r=>`drop:${r}`),
 ...SHADOW_REFUSALS.map(r=>`refuse:${r}`),
 ...SHADOW_REFUSALS.map(r=>`discard:${r}`),
] as const);
export type ShadowCounter=typeof SHADOW_COUNTERS[number];

export interface ShadowStatus {
 enabled:boolean;dailyCap:number;revision:number;clearGeneration:number;
 /** 本地日期 YYYY-MM-DD。 */
 day:string;used:number;stopped:ShadowStopReason|null;
 /** 来源仍有效的记录数。 */
 records:number;
 counters:Partial<Record<ShadowCounter,number>>;
}

export interface ShadowExportRecord {
 candidate:ShadowCandidate;sourceRef:BoundSourceRef;
 profile:{id:string;revision:number};promptVersion:string;recordedAt:number;
}

export type ShadowReserveResult={status:'reserved';day:string;used:number}|{status:'refused';reason:ShadowRefusal};
export type ShadowRecordResult={status:'recorded';written:number}|{status:'refused';reason:ShadowRefusal};
