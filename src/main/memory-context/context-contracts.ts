import type {ChatMessage} from "../orchestrator/vendors/types";
import type {BoundSourceRef,FactView} from "../../shared/memory-contracts";
export interface ContextFact extends FactView {supportSourceRefs:BoundSourceRef[];temporalQuery?:import("../../shared/memory-contracts").FactTime&{coverage:"full"|"partial"}}
export interface FactSupportDependency {factId:string;revision:number;sourceRefs:BoundSourceRef[]}
export type JsonValue=null|boolean|number|string|JsonValue[]|{[key:string]:JsonValue};
export interface RequestIdentity {providerId:string;model:string;transport:string;framingVersion:string}
/** Prepared provider input, without credentials/headers. Never a renderer DTO. */
export interface PreparedRequest extends RequestIdentity {body:{[key:string]:JsonValue};inputTypes:string[];maxOutputTokens?:number}
export interface TokenCounter {capability:RequestIdentity&{mode:"exact"|"estimate";inputTypes:string[]};count(request:Readonly<PreparedRequest>,options?:{signal?:AbortSignal}):Promise<number>}
export interface ContextBudget {admissionMode?:"bounded";maxContextTokens:number;maxInputTokens?:number;reservedOutputTokens:number;safetyMarginTokens:number;maxSTokens:number;minRecentCompleteTurns:number}
export interface ContextToolCall {id:string;name:string;arguments:string}
/** Canonical vendor message plus a text-only projection for source/suppression bookkeeping. */
export interface ContextMessage extends ChatMessage {text:string;toolCallIds?:string[]}
export interface ContextUnit {id:string;kind:"recent"|"summary";messages:ContextMessage[]}
export interface BudgetInput {counter:TokenCounter;budget:ContextBudget;units:ContextUnit[];prepare:(units:ContextUnit[])=>PreparedRequest;prepareS:(units:ContextUnit[])=>PreparedRequest;signal?:AbortSignal}
export interface BoundedEstimates {estimatedPromptTokens:number;estimatedSTokens:number;selectionInputLimit:number}
interface BudgetBase {request:PreparedRequest;requestDigest:string;selectedIds:string[];counterIdentity:RequestIdentity}
export type BudgetResult=BudgetBase&({admissionMode?:"exact";promptTokens:number;sTokens:number;inputLimit:number;estimates?:never}|{admissionMode:"bounded";estimates:BoundedEstimates;promptTokens?:never;sTokens?:never;inputLimit?:never});
export interface FactDependency {factId:string;revision:number}
/** Matches the existing memory Worker request deadline; no delayed claim sends. */
export const CONTEXT_CLAIM_WINDOW_MS=5000;
export interface SourceDependency {sourceRef:BoundSourceRef;subjectKeys:string[]|null;derivedRefs:BoundSourceRef[]|null;excludeReason?:"secret"}
export interface ContextTransport {contextCommand(command:unknown):Promise<unknown>}
export interface TranscriptDependency {headId:string;revision:number;digest:string}
export interface SummarySegment {sourceRef:BoundSourceRef;span:{start:number;end:number};role:ContextMessage["role"]}
export type SummaryCounting=
 | {mode:"exact";framingVersion:string;beforeTokens:number;afterTokens:number}
 | {mode:"estimate";framingVersion:string;estimatedBeforeTokens:number;estimatedAfterTokens:number};
/** Legacy exact callers retain their receipt shape; runtime and bounded summaries label counting explicitly. */
export interface SummaryReceipt {status:"committed"|"no-benefit";summaryId:string|null;counting?:SummaryCounting}
export interface StoredSummary {actorKey:string;providerId:string;sessionId:string;bootId:string;id:string;generation:number;sourceDeps:SourceDependency[];inputRefs:BoundSourceRef[];segments:SummarySegment[];transcriptRefs?:TranscriptDependency[];transcriptSegments?:TranscriptDependency[];counting?:SummaryCounting}
/** Error text is always a reason code, never a provider/body payload. */
export class ContextError extends Error {constructor(readonly code:string){super(code);this.name="ContextError"}}
export function contextFail(code:string):never {throw new ContextError(code)}
