import type {BoundSourceRef} from "../../shared/memory-contracts";
import type {Extraction,Attribute} from "./extractor";
export interface IntegrationResult {items:PolicyOutcome[]}
export interface PolicyBaseline {factId:string;revision:number;subjectKey:string}
/** Private worker/Main contracts, never renderer DTOs. */
export interface PolicyTransport {policyCommand(value:unknown):Promise<unknown>}
export interface PolicyOutcome {status:"candidate"|"active"|"rejected"|"suppressed"|"forgotten"|"pending-review";reason?:string;candidateId?:string;candidateRevision?:number;factId?:string;factRevision?:number}
/** Readiness describes extracted content, never authorization to activate it. */
export interface PolicyCandidate {reviewState:"ready"|"reference-only";occurredAt:number|null;time?:import("../../shared/memory-contracts").FactTime;candidateId:string;revision:number;attribute:Attribute;value:string|null;reason:string;sourceRef:BoundSourceRef;assertion:string;projectKey?:string;contentHash?:string;typed?:import("../../shared/memory-contracts").TypedUserFact}
export interface PolicyEvent {kind:"confirm"|"confirmFact"|"deny"|"reject"|"revise"|"resolve"|"correct"|"forget"|"remember";nonce:string;generation:number;candidateId?:string;factId?:string;revision?:number;sourceRef?:BoundSourceRef;extraction?:Extraction;contentHash?:string;scopeBinding?:string;naturalEdit?:import("./natural-protocol").NaturalProposal;sourceText?:string}
