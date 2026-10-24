import type {BoundSourceRef} from "./memory-contracts";

/** Host-owned consent. Missing/corrupt control records never imply opt-in. */
export interface NaturalAutomationConfig {revision:number;language:boolean;responseStyle:boolean}
export type NaturalJobPhase="unsent"|"result-unknown"|"result-saved"|"applied"|"blocked";
export type NaturalJobReason="disabled"|"conflict"|"source-changed"|"scope-denied"|"suppressed"|"stale-consent"|"profile-changed"|"limits"|"budget"|"usage"|"provider"|"expired"|"corrupt"|"cancelled";
export interface NaturalRequestLimits {requestBytes:number;outputTokens:number}

export interface NaturalModelProfile {readonly id:string;readonly revision:number}
export interface NaturalJobView {
 readonly id:string;readonly revision:number;readonly phase:NaturalJobPhase;readonly sourceRef:BoundSourceRef;
 readonly profile:NaturalModelProfile;readonly createdAt:number;readonly updatedAt:number;readonly reason?:NaturalJobReason;
 readonly outcome?:{readonly items:ReadonlyArray<{status:string;candidateId?:string;candidateRevision?:number;factId?:string;factRevision?:number;reason?:string}>};
}
export interface MemoryAutomationState {
 readonly available:boolean;readonly reason?:string;readonly config:NaturalAutomationConfig;
 readonly budget:{day:number;requests:number;units:number;closed:boolean};
 readonly counts:Record<NaturalJobPhase,number>;
}
export interface MemoryAutomationConfigure {expectedRevision:number;language:boolean;responseStyle:boolean}
export type MemoryAutomationResult={status:"updated";state:MemoryAutomationState}|{status:"rejected";reason:string};
export interface MemoryAutomationPanelApi {state():Promise<MemoryAutomationState>;configure(input:MemoryAutomationConfigure):Promise<MemoryAutomationResult>}
