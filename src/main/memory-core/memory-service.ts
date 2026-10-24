import type {EvidenceInput,CandidateInput,ActivateInput,CorrectInput,ForgetInput,FactView,MutationResult,SourceRef} from "../../shared/memory-contracts";
import {requireMainAccess,requireActivation} from "./main-access";
import {objectFields,parseSourceRef,parseFact,positiveRevision,textField} from "./command-validation";
import {parseJobBody} from "./jobs";
import {parseInternalId} from "./command-validation";
export interface MemoryServiceTransport {
 jobCommand?:(command:unknown)=>Promise<unknown>;
 execute(command:unknown):Promise<MutationResult>;
 current(scopeKey:string):Promise<FactView[]>;
 history?(scopeKey:string,factId:string):Promise<FactView[]>;
}
export class MemoryService {
 constructor(private readonly client:MemoryServiceTransport){}
 private async job(access:unknown,kind:string,input:unknown,fields:string[]):Promise<unknown>{
  const context=requireMainAccess(access),value=objectFields(input,["commandId",...fields]);
  const {commandId,...rest}=value,body=parseJobBody(kind,rest);
  if(kind==="enqueue")context.verifySource(body.sourceRef as SourceRef);
  if(!this.client.jobCommand)throw new Error("MEMORY_PROTOCOL_INVALID");
  return this.client.jobCommand({kind,scopeKey:context.scopeKey,commandId:parseInternalId(commandId),body});
 }
 async enqueueJob(access:unknown,input:import("../../shared/memory-contracts").EnqueueJobInput):Promise<MutationResult>{return this.job(access,"enqueue",input,["jobId","sourceRef"]) as Promise<MutationResult>}
 async claimJob(access:unknown,input:import("../../shared/memory-contracts").ClaimJobInput):Promise<import("../../shared/memory-contracts").JobLease>{return this.job(access,"claim",input,["jobId","leaseMs"]) as Promise<import("../../shared/memory-contracts").JobLease>}
 async commitJobResult(access:unknown,input:import("../../shared/memory-contracts").CommitJobInput):Promise<MutationResult>{return this.job(access,"commit",input,["jobId","leaseToken","proposals"]) as Promise<MutationResult>}
 async registerSource(access:unknown,commandId:string,value:SourceRef):Promise<MutationResult>{
  const context=requireMainAccess(access),sourceRef=parseSourceRef(value),source=context.verifySource(sourceRef);
  return this.client.execute({kind:"registerSource",scopeKey:context.scopeKey,commandId:parseInternalId(commandId),body:{sourceRef,kind:source.kind,intent:source.intent,candidateId:source.candidateId??null,factId:source.factId??null}});
 }
 async appendEvidence(access:unknown,input:EvidenceInput):Promise<MutationResult>{
  const context=requireMainAccess(access),value=objectFields(input,["commandId","evidenceId","sourceRef","text"]);
  const sourceRef=parseSourceRef(value.sourceRef);context.verifySource(sourceRef);
  return this.client.execute({kind:"appendEvidence",scopeKey:context.scopeKey,commandId:parseInternalId(value.commandId),body:{evidenceId:parseInternalId(value.evidenceId),sourceRef,text:textField(value.text)}});
 }
 async proposeCandidate(access:unknown,input:CandidateInput):Promise<MutationResult>{
  const context=requireMainAccess(access),value=objectFields(input,["commandId","candidateId","evidenceId","fact"]);
  return this.client.execute({kind:"proposeCandidate",scopeKey:context.scopeKey,commandId:parseInternalId(value.commandId),body:{candidateId:parseInternalId(value.candidateId),evidenceId:parseInternalId(value.evidenceId),fact:parseFact(value.fact)}});
 }
 async activateCandidate(access:unknown,authorization:unknown,input:ActivateInput):Promise<MutationResult>{
  const context=requireMainAccess(access),value=objectFields(input,["commandId","candidateId"]),candidateId=parseInternalId(value.candidateId);
  const claim=requireActivation(access,authorization,candidateId);
  return this.client.execute({kind:"activateCandidate",scopeKey:context.scopeKey,commandId:parseInternalId(value.commandId),body:{candidateId,authorization:claim}});
 }
 async correctFact(access:unknown,input:CorrectInput):Promise<MutationResult>{
  const context=requireMainAccess(access),value=objectFields(input,["commandId","factId","expectedRevision","sourceRef","fact"]);
  const factId=parseInternalId(value.factId),sourceRef=parseSourceRef(value.sourceRef),source=context.verifySource(sourceRef);
  if(source.kind!=="user"||source.intent!=="correction"||source.factId!==factId)throw new Error("MEMORY_ACCESS_DENIED");
  return this.client.execute({kind:"correctFact",scopeKey:context.scopeKey,commandId:parseInternalId(value.commandId),body:{factId,expectedRevision:positiveRevision(value.expectedRevision),sourceRef,fact:parseFact(value.fact)}});
 }
 async forgetFact(access:unknown,input:ForgetInput):Promise<MutationResult>{
  const context=requireMainAccess(access),value=objectFields(input,["commandId","factId","expectedRevision","sourceRef"]);
  const factId=parseInternalId(value.factId),sourceRef=parseSourceRef(value.sourceRef),source=context.verifySource(sourceRef);
  if(source.kind!=="user"||source.intent!=="forget"||source.factId!==factId)throw new Error("MEMORY_ACCESS_DENIED");
  return this.client.execute({kind:"forgetFact",scopeKey:context.scopeKey,commandId:parseInternalId(value.commandId),body:{factId,expectedRevision:positiveRevision(value.expectedRevision),sourceRef}});
 }
 async current(access:unknown):Promise<FactView[]>{return this.client.current(requireMainAccess(access).scopeKey)}
 async history(access:unknown,factId:string):Promise<FactView[]>{
  const context=requireMainAccess(access);if(!this.client.history)throw new Error("MEMORY_PROTOCOL_INVALID");
  return this.client.history(context.scopeKey,parseInternalId(factId));
 }
}
