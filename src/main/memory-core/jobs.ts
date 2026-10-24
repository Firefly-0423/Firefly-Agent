import {randomUUID} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import type {SourceRef,JobLease,JobProposal,MutationResult} from "../../shared/memory-contracts";
import {parseInternalId,objectFields,parseSourceRef,parseFact,textField} from "./command-validation";
import {executeTransaction,type TransactionFault} from "./command-transactions";
import {RecordCodec} from "./record-codec";
import {Suppression} from "./suppression";
import {FactRepository} from "./fact-repository";
import {SourceLedger} from "./source-ledger";
interface JobRecord {sourceRef:SourceRef;suppressionGeneration:number;state:"pending"|"running"|"complete";revision:number;leaseToken:string|null;leaseExpiresAt:number|null}
export function parseJobBody(kind:string,value:unknown):Record<string,unknown>{
 if(kind==="enqueue"){
  const b=objectFields(value,["jobId","sourceRef"]);return{jobId:parseInternalId(b.jobId),sourceRef:parseSourceRef(b.sourceRef)};
 }
 if(kind==="claim"){
  const b=objectFields(value,["jobId","leaseMs"]);
  if(typeof b.leaseMs!=="number"||!Number.isSafeInteger(b.leaseMs)||b.leaseMs<1||b.leaseMs>60000)throw new Error("MEMORY_INPUT_INVALID");
  return{jobId:parseInternalId(b.jobId),leaseMs:b.leaseMs};
 }
 if(kind==="commit"){
  const b=objectFields(value,["jobId","leaseToken","proposals"]);
  if(!Array.isArray(b.proposals)||b.proposals.length===0||b.proposals.length>100)throw new Error("MEMORY_INPUT_INVALID");
  const proposals=b.proposals.map((value:unknown):JobProposal=>{
   const v=objectFields(value,["candidateId","evidenceId","text","fact"]);
   return{candidateId:parseInternalId(v.candidateId),evidenceId:parseInternalId(v.evidenceId),text:textField(v.text),fact:parseFact(v.fact)};
  });
  return{jobId:parseInternalId(b.jobId),leaseToken:parseInternalId(b.leaseToken),proposals};
 }
 throw new Error("MEMORY_INPUT_INVALID");
}
export class JobRepository {
 private readonly codec:RecordCodec;private readonly suppression:Suppression;
 constructor(private readonly db:DatabaseSync,private readonly key:Uint8Array,private readonly clock:()=>number,private readonly fault?:TransactionFault){
  this.codec=new RecordCodec(key);this.suppression=new Suppression(db,key);
 }
 private now():number{const n=this.clock();if(!Number.isSafeInteger(n)||n<0)throw new Error("MEMORY_CLOCK_INVALID");return n}
 private source(scope:string,ref:SourceRef):void{
  new SourceLedger(this.db,this.key).assertCurrent(scope,ref);
  const row=this.db.prepare("SELECT revision,payload FROM sources WHERE id=? AND scope_key=?").get(ref.sourceId,scope);
  if(!row)throw new Error("MEMORY_SOURCE_INVALID");
  const source=this.codec.open<{sourceRef:SourceRef}>("sources",scope,ref.sourceId,row.payload);
  if(source.sourceRef.sourceId!==ref.sourceId||source.sourceRef.revision!==row.revision)throw new Error("MEMORY_DATA_INVALID");
  if(row.revision!==ref.revision)throw new Error("MEMORY_JOB_SOURCE_STALE");
 }
 private job(scope:string,id:string):JobRecord{
  const row=this.db.prepare("SELECT revision,state,payload FROM jobs WHERE id=? AND scope_key=?").get(id,scope);
  if(!row)throw new Error("MEMORY_JOB_NOT_FOUND");
  const value=this.codec.open<JobRecord>("jobs",scope,id,row.payload);
  if(value.revision!==row.revision||value.state!==row.state||!Number.isSafeInteger(value.suppressionGeneration)||value.suppressionGeneration<0)throw new Error("MEMORY_DATA_INVALID");
  parseSourceRef(value.sourceRef);return value;
 }
 private validate(scope:string,job:JobRecord):void{
  if(job.suppressionGeneration!==this.suppression.generation(scope)||this.suppression.sourceBlocked(scope,job.sourceRef))throw new Error("MEMORY_JOB_SUPPRESSED");
  this.source(scope,job.sourceRef);
 }
 private update(scope:string,id:string,job:JobRecord):void{
  job.revision++;this.db.prepare("UPDATE jobs SET revision=?,state=?,payload=? WHERE id=? AND scope_key=?")
   .run(job.revision,job.state,this.codec.seal("jobs",scope,id,job),id,scope);this.fault?.("after-record");
 }
 execute(value:unknown):MutationResult|JobLease{
  const cmd=objectFields(value,["kind","scopeKey","commandId","body"]),scope=parseInternalId(cmd.scopeKey),commandId=parseInternalId(cmd.commandId);
  if(typeof cmd.kind!=="string")throw new Error("MEMORY_INPUT_INVALID");
  const body=parseJobBody(cmd.kind,cmd.body),id=body.jobId as string;
  return executeTransaction<MutationResult|JobLease>({db:this.db,key:this.key,scope,commandId,request:{...cmd,body},fault:this.fault,apply:()=>{
   if(cmd.kind==="enqueue"){
    const ref=body.sourceRef as SourceRef;this.source(scope,ref);
    if(this.suppression.sourceBlocked(scope,ref))throw new Error("MEMORY_SOURCE_SUPPRESSED");
    const job:JobRecord={sourceRef:ref,suppressionGeneration:this.suppression.generation(scope),state:"pending",revision:1,leaseToken:null,leaseExpiresAt:null};
    this.db.prepare("INSERT INTO jobs (id,scope_key,revision,source_id,parent_id,state,payload) VALUES(?,?,1,?,NULL,'pending',?)").run(id,scope,ref.sourceId,this.codec.seal("jobs",scope,id,job));
    this.fault?.("after-record");return{id,revision:1};
   }
   const job=this.job(scope,id);this.validate(scope,job);const now=this.now();
   if(cmd.kind==="claim"){
    if(job.state==="complete")throw new Error("MEMORY_JOB_COMPLETE");
    if(job.state==="running"&&job.leaseExpiresAt!==null&&now<job.leaseExpiresAt)throw new Error("MEMORY_JOB_BUSY");
    const expires=now+(body.leaseMs as number);if(!Number.isSafeInteger(expires))throw new Error("MEMORY_CLOCK_INVALID");
    job.state="running";job.leaseToken=randomUUID();job.leaseExpiresAt=expires;this.update(scope,id,job);
    return{jobId:id,leaseToken:job.leaseToken,leaseExpiresAt:expires,sourceRef:job.sourceRef,suppressionGeneration:job.suppressionGeneration};
   }
   if(job.state!=="running"||job.leaseToken!==body.leaseToken||job.leaseExpiresAt===null||now>=job.leaseExpiresAt)throw new Error("MEMORY_JOB_LEASE_INVALID");
   const facts=new FactRepository(this.db,this.key,this.fault);
   for(const proposal of body.proposals as JobProposal[]){
    facts.applyWithinTransaction(scope,"appendEvidence",{evidenceId:proposal.evidenceId,sourceRef:job.sourceRef,text:proposal.text});
    facts.applyWithinTransaction(scope,"proposeCandidate",{candidateId:proposal.candidateId,evidenceId:proposal.evidenceId,fact:proposal.fact});
   }
   job.state="complete";job.leaseToken=null;job.leaseExpiresAt=null;this.update(scope,id,job);return{id,revision:job.revision};
  }});
 }
}
