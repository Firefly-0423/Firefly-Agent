/** Safe cross-process business DTOs. No paths, keys, database handles or authorization constructors. */
export interface SourceBinding {providerId:string;sessionId:string;messageId:string;contentRevision:number;generation:string}
export interface SourceRef {sourceId:string;revision:number;span?:{start:number;end:number};binding?:SourceBinding}
export interface BoundSourceRef extends SourceRef {binding:SourceBinding}
export interface FactTime {validFrom:number|null;validTo:number|null;referenceTime:number|null}
export interface FactDraft {subjectKey:string;assertion:string;assertionKind:"user-statement"|"inference";time:FactTime}
/** Worker-validated data only. These identifiers confer no read/tool/instruction authority. */
export interface TypedUserFact {
 version:2;attribute:"address"|"language"|"response-style"|"tool"|"preference";value:string;canonicalValue:string;polarity:"positive"|"negative";cardinality:"one"|"many";
 entityKey:string;slotKey:string;assertionKey:string;legacyAttribute:"address"|"language"|"response-style"|"shell"|"tool"|"preference";
}
export type ActivationReason="policyAccepted"|"explicitUserConfirmed";
export interface FactView extends FactDraft {
 typed?:TypedUserFact;
 factId:string;revision:number;sourceRef:SourceRef;recordedAt:number;acceptedAt:number;
 supersededAt:number|null;activationReason:ActivationReason;policyVersion:string|null;
 provenance:{candidateId:string|null;evidenceId:string|null;activationSourceRef:SourceRef};
 /** Where the fact applies: every session (`global`) or only the workspace it was learned in (`project`). Set by policy recall. */
 scope?:"global"|"project";
 /** Opaque project key, Main-internal: the settings DTO replaces it with `projectName`. */
 projectKey?:string;
 /** Display name of the project a project-scoped fact belongs to, when Main still knows a session bound to it. */
 projectName?:string;
}
export interface MutationResult {id:string;revision:number}
export interface EvidenceInput {commandId:string;evidenceId:string;sourceRef:SourceRef;text:string}
export interface CandidateInput {commandId:string;candidateId:string;evidenceId:string;fact:FactDraft}
export interface ActivateInput {commandId:string;candidateId:string}
export interface CorrectInput {commandId:string;factId:string;expectedRevision:number;sourceRef:SourceRef;fact:FactDraft}
export interface ForgetInput {commandId:string;factId:string;expectedRevision:number;sourceRef:SourceRef}

export interface EnqueueJobInput {commandId:string;jobId:string;sourceRef:SourceRef}
export interface ClaimJobInput {commandId:string;jobId:string;leaseMs:number}
export interface JobLease {jobId:string;leaseToken:string;leaseExpiresAt:number;sourceRef:SourceRef;suppressionGeneration:number}
export interface JobProposal {candidateId:string;evidenceId:string;text:string;fact:FactDraft}
export interface CommitJobInput {commandId:string;jobId:string;leaseToken:string;proposals:readonly JobProposal[]}
