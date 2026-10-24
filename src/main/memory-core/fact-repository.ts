import {createHmac,hkdfSync,randomUUID,timingSafeEqual} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import type {SourceRef,FactDraft,FactView,MutationResult,ActivationReason} from "../../shared/memory-contracts";
import {objectFields,parseSourceRef,parseFact,parseInternalId,positiveRevision,textField} from "./command-validation";
import {executeTransaction,type TransactionFault} from "./command-transactions";
import {sealPayload,openPayload} from "./payload-codec";
import {Suppression} from "./suppression";
import {canonicalJson} from "./repository-types";
import {SourceLedger} from "./source-ledger";
import {transactionNow} from "./transaction-clock";
interface Projection {view:FactView;visibility:"active"|"forgotten"}
export class FactRepository {
 constructor(private readonly db:DatabaseSync,private readonly key:Uint8Array,private readonly fault?:TransactionFault){}
 private seal(table:string,scope:string,id:string,value:unknown):Buffer{
  const plain=Buffer.from(canonicalJson(value));
  try{return sealPayload(this.key,{recordType:table,id:JSON.stringify([scope,id]),schemaVersion:1,keyVersion:1},plain)}finally{plain.fill(0)}
 }
 private open<T>(table:string,scope:string,id:string,value:unknown):T{
  if(!(value instanceof Uint8Array))throw new Error("MEMORY_DATA_INVALID");
  const plain=openPayload(this.key,{recordType:table,id:JSON.stringify([scope,id]),schemaVersion:1,keyVersion:1},value);
  try{return JSON.parse(plain.toString("utf8")) as T}finally{plain.fill(0)}
 }
 private row(table:string,scope:string,id:string){
  return this.db.prepare("SELECT * FROM "+table+" WHERE id=? AND scope_key=?").get(id,scope);
 }
 private source(scope:string,ref:SourceRef):{kind:string;sourceRef:SourceRef;intent?:string;candidateId?:string|null;factId?:string|null}{
  new SourceLedger(this.db,this.key).assertCurrent(scope,ref);
  const row=this.row("sources",scope,ref.sourceId);
  if(!row)throw new Error("MEMORY_SOURCE_INVALID");
  const source=this.open<{kind:string;sourceRef:SourceRef;intent?:string;candidateId?:string|null;factId?:string|null}>("sources",scope,ref.sourceId,row.payload);
  if(row.revision!==source.sourceRef.revision||source.sourceRef.sourceId!==ref.sourceId)throw new Error("MEMORY_DATA_INVALID");
  if(source.sourceRef.revision!==ref.revision)throw new Error("MEMORY_SOURCE_STALE");
  return source;
 }
 private insert(table:string,scope:string,id:string,revision:number,state:string,payload:unknown,sourceId:string|null=null,parentId:string|null=null){
  this.db.prepare("INSERT INTO "+table+" (id,scope_key,revision,source_id,parent_id,state,payload) VALUES (?,?,?,?,?,?,?)")
   .run(id,scope,revision,sourceId,parentId,state,this.seal(table,scope,id,payload));
  this.fault?.("after-record");
 }
 private subjectIndex(subject:string):Buffer{
  const derived=Buffer.from(hkdfSync("sha256",this.key,Buffer.alloc(0),"FireflyMemorySubjectIndex-v1",32));
  try{return createHmac("sha256",derived).update(subject,"utf8").digest()}finally{derived.fill(0)}
 }
 private projection(scope:string,factId:string):Projection{
  const row=this.row("current_facts",scope,factId);
  if(!row||row.state!=="active")throw new Error("MEMORY_FACT_NOT_FOUND");
  const projection=this.open<Projection>("current_facts",scope,factId,row.payload);
  const index=this.subjectIndex(projection.view.subjectKey);
  if(projection.visibility!=="active"||projection.view.factId!==factId||projection.view.revision!==row.revision||!(row.subject_index instanceof Uint8Array)||row.subject_index.length!==index.length||!timingSafeEqual(index,row.subject_index))throw new Error("MEMORY_DATA_INVALID");
  return projection;
 }
 private assertNoIntervalConflict(scope:string,fact:FactDraft,exceptId?:string):void {
  for(const row of this.db.prepare("SELECT id FROM current_facts WHERE scope_key=? AND subject_index=? AND state='active'").all(scope,this.subjectIndex(fact.subjectKey))){
   if(row.id===exceptId)continue;
   const {subjectKey,assertion,assertionKind,time}=this.projection(scope,row.id as string).view;
   const previous=parseFact({subjectKey,assertion,assertionKind,time}),a=fact.time,b=previous.time;
   if((a.validFrom??-Infinity)<(b.validTo??Infinity)&&(b.validFrom??-Infinity)<(a.validTo??Infinity))throw Error("MEMORY_FACT_CONFLICT");
  }
 }
 private appendRevision(scope:string,view:FactView):string{
  const id=randomUUID();
  this.db.prepare("INSERT INTO fact_revisions (id,scope_key,revision,source_id,parent_id,state,payload,fact_id,event_kind) VALUES (?,?,?,?,?,?,?,?,?)")
   .run(id,scope,view.revision,view.sourceRef.sourceId,null,"recorded",this.seal("fact_revisions",scope,id,view),view.factId,"assertion");
  this.fault?.("after-record");return id;
 }
 private lifecycle(scope:string,view:FactView,target:string,kind:"supersession"|"forget",at:number){
  const id=randomUUID(),payload={factId:view.factId,targetRevision:view.revision,at};
  this.db.prepare("INSERT INTO fact_revisions (id,scope_key,revision,source_id,parent_id,state,payload,fact_id,event_kind) VALUES (?,?,?,?,?,?,?,?,?)")
   .run(id,scope,view.revision,view.sourceRef.sourceId,target,kind==="forget"?"forgotten":"superseded",this.seal("fact_revisions",scope,id,payload),view.factId,kind);
  this.fault?.("after-record");
 }
 private invalidate(scope:string,factId:string,revision:number){
  this.insert("index_state",scope,randomUUID(),revision,"invalidated",{factId,revision});
 }
 execute(value:unknown):MutationResult{
  const command=objectFields(value,["kind","scopeKey","commandId","body"]);
  const scope=parseInternalId(command.scopeKey),commandId=parseInternalId(command.commandId);
  if(!["registerSource","appendEvidence","proposeCandidate","activateCandidate","correctFact","forgetFact"].includes(command.kind as string))throw new Error("MEMORY_INPUT_INVALID");
  return executeTransaction({db:this.db,key:this.key,scope,commandId,request:value,fault:this.fault,apply:()=>this.applyWithinTransaction(scope,command.kind as string,command.body)});
 }
 applyWithinTransaction(scope:string,kind:string,body:unknown):MutationResult{
  if(!this.db.isTransaction)throw new Error("MEMORY_TRANSACTION_REQUIRED");
  const command={kind,body},suppression=new Suppression(this.db,this.key);
   switch(command.kind){
    case "registerSource":{
     const body=objectFields(command.body,["sourceRef","kind"],["intent","candidateId","factId"]),ref=parseSourceRef(body.sourceRef);
     if(new SourceLedger(this.db,this.key).isManaged(scope,ref.sourceId))throw new Error("MEMORY_SOURCE_MANAGED");
     const intent=body.intent??"statement",candidateId=body.candidateId??null,factId=body.factId??null;
     if(!["statement","confirmation","correction","forget","remember"].includes(intent as string))throw new Error("MEMORY_SOURCE_INVALID");
     if(candidateId!==null)parseInternalId(candidateId);if(factId!==null)parseInternalId(factId);
     const registered={sourceRef:ref,kind:body.kind,intent,candidateId,factId};
     if(!["user","assistant","system"].includes(body.kind as string))throw new Error("MEMORY_SOURCE_INVALID");
     const old=this.row("sources",scope,ref.sourceId);
     if(old){
      const previous=this.open<{kind:string;sourceRef:SourceRef;intent?:string;candidateId?:string|null;factId?:string|null}>("sources",scope,ref.sourceId,old.payload);
      if(previous.kind!==body.kind||(ref.revision===old.revision&&((previous.intent??"statement")!==intent||(previous.candidateId??null)!==candidateId||(previous.factId??null)!==factId)))throw new Error("MEMORY_SOURCE_INVALID");
      if(ref.revision<(old.revision as number))throw new Error("MEMORY_SOURCE_STALE");
      if(ref.revision> (old.revision as number))this.db.prepare("UPDATE sources SET revision=?,payload=? WHERE id=? AND scope_key=?").run(ref.revision,this.seal("sources",scope,ref.sourceId,registered),ref.sourceId,scope);
     }else this.insert("sources",scope,ref.sourceId,ref.revision,"recorded",registered);
     return{id:ref.sourceId,revision:ref.revision};
    }
    case "appendEvidence":{
     const body=objectFields(command.body,["evidenceId","sourceRef","text"]),id=parseInternalId(body.evidenceId),sourceRef=parseSourceRef(body.sourceRef);
     this.source(scope,sourceRef);this.insert("evidence",scope,id,1,"recorded",{sourceRef,text:textField(body.text)},sourceRef.sourceId);
     return{id,revision:1};
    }
    case "proposeCandidate":{
     const body=objectFields(command.body,["candidateId","evidenceId","fact"]),id=parseInternalId(body.candidateId),evidenceId=parseInternalId(body.evidenceId);
     const evidence=this.row("evidence",scope,evidenceId);if(!evidence)throw new Error("MEMORY_EVIDENCE_NOT_FOUND");
     const sourceRef=parseSourceRef(this.open<{sourceRef:SourceRef}>("evidence",scope,evidenceId,evidence.payload).sourceRef);
     this.source(scope,sourceRef);this.insert("candidates",scope,id,1,"proposed",{sourceRef,fact:parseFact(body.fact)},sourceRef.sourceId,evidenceId);
     return{id,revision:1};
    }
    case "activateCandidate":{
     const body=objectFields(command.body,["candidateId","authorization"]),candidateId=parseInternalId(body.candidateId);
     const row=this.row("candidates",scope,candidateId);if(!row||row.state!=="proposed")throw new Error("MEMORY_CANDIDATE_NOT_FOUND");
     const proposal=this.open<{sourceRef:SourceRef;fact:FactDraft}>("candidates",scope,candidateId,row.payload),sourceRef=parseSourceRef(proposal.sourceRef),source=this.source(scope,sourceRef),fact=parseFact(proposal.fact);
     const auth=objectFields(body.authorization,["reason","sourceRef","policyVersion"]),eventRef=parseSourceRef(auth.sourceRef),event=this.source(scope,eventRef);
     if(event.kind!=="user"||!["policyAccepted","explicitUserConfirmed"].includes(auth.reason as string))throw new Error("MEMORY_ACTIVATION_DENIED");
     if(auth.reason==="policyAccepted"&&(source.kind!=="user"||fact.assertionKind!=="user-statement"||eventRef.sourceId!==sourceRef.sourceId||eventRef.revision!==sourceRef.revision||typeof auth.policyVersion!=="string"))throw new Error("MEMORY_ACTIVATION_DENIED");
     if(auth.reason==="explicitUserConfirmed"&&(auth.policyVersion!==null||!["confirmation","remember"].includes(event.intent??"")||event.candidateId!==candidateId))throw new Error("MEMORY_ACTIVATION_DENIED");
     if(auth.reason==="policyAccepted"&&event.intent!=="statement")throw new Error("MEMORY_ACTIVATION_DENIED");
     if(suppression.subjectBlocked(scope,fact.subjectKey)){
      if(event.intent!=="remember"||auth.reason!=="explicitUserConfirmed"||suppression.sourceBlocked(scope,eventRef)||suppression.sourceBlocked(scope,sourceRef))throw new Error("MEMORY_SUBJECT_SUPPRESSED");
      suppression.advance(scope);
     }else if(suppression.sourceBlocked(scope,sourceRef))throw new Error("MEMORY_SOURCE_SUPPRESSED");
     const index=this.subjectIndex(fact.subjectKey);
     this.assertNoIntervalConflict(scope,fact);
     const id=randomUUID(),at=transactionNow(this.db),view:FactView={...fact,factId:id,revision:1,sourceRef,recordedAt:at,acceptedAt:at,supersededAt:null,activationReason:auth.reason as ActivationReason,policyVersion:auth.policyVersion as string|null,provenance:{candidateId,evidenceId:row.parent_id as string,activationSourceRef:eventRef}};
     const revisionId=this.appendRevision(scope,view);
     this.db.prepare("INSERT INTO current_facts (id,scope_key,revision,source_id,parent_id,state,payload,subject_index) VALUES (?,?,?,?,?,?,?,?)").run(id,scope,1,sourceRef.sourceId,revisionId,"active",this.seal("current_facts",scope,id,{view,visibility:"active"}),index);
     this.db.prepare("UPDATE candidates SET state='active' WHERE id=? AND scope_key=?").run(candidateId,scope);this.invalidate(scope,id,1);
     return{id,revision:1};
    }
    case "correctFact":{
     const body=objectFields(command.body,["factId","expectedRevision","sourceRef","fact"],["policyVersion"]),id=parseInternalId(body.factId),expected=positiveRevision(body.expectedRevision),sourceRef=parseSourceRef(body.sourceRef),fact=parseFact(body.fact);
     const previous=this.projection(scope,id).view;if(previous.revision!==expected)throw new Error("MEMORY_REVISION_CONFLICT");
     if(this.source(scope,sourceRef).kind!=="user")throw new Error("MEMORY_ACCESS_DENIED");
     if(fact.subjectKey!==previous.subjectKey&&suppression.subjectBlocked(scope,fact.subjectKey))throw new Error("MEMORY_SUBJECT_SUPPRESSED");
     const index=this.subjectIndex(fact.subjectKey);this.assertNoIntervalConflict(scope,fact,id);
     if(body.policyVersion!==undefined){
      const observation=new SourceLedger(this.db,this.key).assertCurrent(scope,sourceRef)?.published;
      if(body.policyVersion!=="main-maintenance-v1"||observation?.role!=="user"||observation.trust!=="direct-user-event"||fact.assertionKind!=="user-statement"||fact.subjectKey!==previous.subjectKey)throw new Error("MEMORY_ACTIVATION_DENIED");
     }
     const target=this.row("current_facts",scope,id)!.parent_id as string,at=transactionNow(this.db),view:FactView={...fact,factId:id,revision:expected+1,sourceRef,recordedAt:at,acceptedAt:at,supersededAt:null,activationReason:body.policyVersion===undefined?"explicitUserConfirmed":"policyAccepted",policyVersion:typeof body.policyVersion==="string"?body.policyVersion:null,provenance:{candidateId:null,evidenceId:null,activationSourceRef:sourceRef}};
     this.lifecycle(scope,previous,target,"supersession",at);
     const revisionId=this.appendRevision(scope,view);
     this.db.prepare("UPDATE current_facts SET revision=?,source_id=?,parent_id=?,subject_index=?,payload=? WHERE id=? AND scope_key=?").run(view.revision,sourceRef.sourceId,revisionId,index,this.seal("current_facts",scope,id,{view,visibility:"active"}),id,scope);
     this.invalidate(scope,id,view.revision);return{id,revision:view.revision};
    }
    case "forgetFact":{
     const body=objectFields(command.body,["factId","expectedRevision","sourceRef"]),id=parseInternalId(body.factId),expected=positiveRevision(body.expectedRevision),sourceRef=parseSourceRef(body.sourceRef);
     const view=this.projection(scope,id).view;if(view.revision!==expected)throw new Error("MEMORY_REVISION_CONFLICT");
     if(this.source(scope,sourceRef).kind!=="user")throw new Error("MEMORY_ACCESS_DENIED");
     const at=transactionNow(this.db);this.lifecycle(scope,view,this.row("current_facts",scope,id)!.parent_id as string,"forget",at);
     this.db.prepare("UPDATE current_facts SET state='forgotten',payload=? WHERE id=? AND scope_key=?").run(this.seal("current_facts",scope,id,{view,visibility:"forgotten"}),id,scope);
     suppression.forget(scope,view,sourceRef,at);
     this.invalidate(scope,id,expected);return{id,revision:expected};
    }
   }
   throw new Error("MEMORY_INPUT_INVALID");
 }
 current(scope:string):FactView[]{
  parseInternalId(scope);
  return this.db.prepare("SELECT id FROM current_facts WHERE scope_key=? AND state='active' ORDER BY id").all(scope).map(row=>this.projection(scope,row.id as string).view);
 }
 history(scope:string,factId:string):FactView[]{
  parseInternalId(scope);parseInternalId(factId);this.projection(scope,factId);
  const rows=this.db.prepare("SELECT id,revision,event_kind,payload FROM fact_revisions WHERE scope_key=? AND fact_id=? ORDER BY revision,id").all(scope,factId);
  const superseded=new Map<number,number>(),views:FactView[]=[];
  for(const row of rows){
   if(row.event_kind==="assertion"){
    const view=this.open<FactView>("fact_revisions",scope,row.id as string,row.payload);
    if(view.factId!==factId||view.revision!==row.revision)throw new Error("MEMORY_DATA_INVALID");
    views.push(view);
   }else if(row.event_kind==="supersession"){
    const event=this.open<{factId:string;targetRevision:number;at:number}>("fact_revisions",scope,row.id as string,row.payload);
    if(event.factId!==factId||event.targetRevision!==row.revision)throw new Error("MEMORY_DATA_INVALID");
    superseded.set(event.targetRevision,event.at);
   }
  }
  return views.sort((a,b)=>a.revision-b.revision).map(view=>({...view,supersededAt:superseded.get(view.revision)??null}));
 }
}
