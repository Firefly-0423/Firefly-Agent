import type {BoundSourceRef} from "../../shared/memory-contracts";
export interface SourceIdentity {providerId:string;sessionId:string;messageId:string}
export type SourceRole="user"|"assistant"|"system";
export type SourceTrust="direct-user-event"|"history"|"imported"|"model"|"system";
/** Main/worker internal metadata. Original text remains at the source provider. */
export interface SourceObservation extends SourceIdentity {
 contentRevision:number;generation:string;state:"live"|"deleted";
 role:SourceRole;trust:SourceTrust;fingerprint:string;
 /** Provider-owned event time; absent remains unknown. */
 occurredAt?:number;
 /** Host calendar zone at the original event; legacy unknown remains absent. */
 timeZone?:string;
}
export interface SourceHead {
 sourceId:string;identity:SourceIdentity;state:"ready"|"pending"|"deleted";
 ref:BoundSourceRef|null;published:SourceObservation|null;operationId:string|null;
 /** Main capture generation, retained for unchanged content; older B1 heads omit it. */
 captureSuppressionGeneration?:number;observedSuppressionGeneration?:number;
 /** Original locator epoch; editing/recapturing history does not create a new user event. */
 firstObservedSuppressionGeneration?:number;
}
export interface SourceLedgerTransport {sourceCommand(command:unknown):Promise<unknown>}
