import {randomUUID} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import type {SourceRef,FactView} from "../../shared/memory-contracts";
import {RecordCodec} from "./record-codec";
import {canonicalJson} from "./repository-types";
interface Marker {factId:string;sourceRef:SourceRef;forgetEvent:SourceRef;at:number;origins?:SourceRef[];subjects?:string[];generation?:number}
/** Recall barrier, worker-only. Old markers remain after a new remember event. */
export class Suppression {
 private readonly codec:RecordCodec;
 constructor(private readonly db:DatabaseSync,key:Uint8Array){this.codec=new RecordCodec(key)}
 private assertions(scope:string,factId:string):FactView[]{
  return this.db.prepare("SELECT id,payload FROM fact_revisions WHERE scope_key=? AND fact_id=? AND event_kind='assertion'").all(scope,factId)
   .map(row=>this.codec.open<FactView>("fact_revisions",scope,row.id as string,row.payload));
 }
 private markers(scope:string):Marker[]{
  return this.db.prepare("SELECT id,payload FROM deletion_markers WHERE scope_key=?").all(scope).map(row=>{
   const marker=this.codec.open<Marker>("deletion_markers",scope,row.id as string,row.payload);
   if(typeof marker.factId!=="string"||!marker.sourceRef)throw new Error("MEMORY_DATA_INVALID");
   if(!marker.origins||!marker.subjects){
    const views=this.assertions(scope,marker.factId);
    marker.origins=views.flatMap(v=>[v.sourceRef,v.provenance.activationSourceRef]);
    marker.subjects=views.map(v=>v.subjectKey);
   }
   return marker;
  });
 }
 generation(scope:string):number{
  const row=this.db.prepare("SELECT generation,payload FROM scope_suppression WHERE scope_key=?").get(scope);
  if(!row)return this.markers(scope).length;
  const value=this.codec.open<{generation:number}>("scope_suppression",scope,scope,row.payload);
  if(!Number.isSafeInteger(value.generation)||value.generation<0||row.generation!==value.generation)throw new Error("MEMORY_DATA_INVALID");
  return value.generation;
 }
 advance(scope:string):number{
  if(!this.db.isTransaction)throw new Error("MEMORY_TRANSACTION_REQUIRED");
  const generation=this.generation(scope)+1;if(!Number.isSafeInteger(generation))throw new Error("MEMORY_DATA_INVALID");
  this.db.prepare("INSERT INTO scope_suppression VALUES(?,?,?) ON CONFLICT(scope_key) DO UPDATE SET generation=excluded.generation,payload=excluded.payload")
   .run(scope,generation,this.codec.seal("scope_suppression",scope,scope,{generation}));return generation;
 }
 sourceBlocked(scope:string,ref:SourceRef):boolean{
  return this.markers(scope).some(m=>m.origins!.some(o=>o.sourceId===ref.sourceId&&ref.revision<=o.revision));
 }
 subjectBlocked(scope:string,subject:string):boolean{return this.markers(scope).some(m=>m.subjects!.includes(subject))}
 /** Add all alternative support origins to the already-created forget barrier. */
 includeOrigins(scope:string,factId:string,refs:SourceRef[]):void {
  if(!this.db.isTransaction)throw new Error("MEMORY_TRANSACTION_REQUIRED");
  for(const row of this.db.prepare("SELECT id,payload FROM deletion_markers WHERE scope_key=?").all(scope)){
   const marker=this.codec.open<Marker>("deletion_markers",scope,row.id as string,row.payload);
   if(marker.factId!==factId)continue;
   const origins=marker.origins??this.assertions(scope,factId).flatMap(v=>[v.sourceRef,v.provenance.activationSourceRef]);
   marker.origins=[...new Map([...origins,...refs].map(ref=>[canonicalJson(ref),ref])).values()];
   this.db.prepare("UPDATE deletion_markers SET payload=? WHERE scope_key=? AND id=?").run(this.codec.seal("deletion_markers",scope,row.id as string,marker),scope,row.id as string);
  }
 }
 forget(scope:string,view:FactView,event:SourceRef,at:number):void{
  const views=this.assertions(scope,view.factId),generation=this.advance(scope),id=randomUUID();
  const marker:Marker={factId:view.factId,sourceRef:view.sourceRef,forgetEvent:event,at,generation,
   origins:views.flatMap(v=>[v.sourceRef,v.provenance.activationSourceRef]),subjects:[...new Set(views.map(v=>v.subjectKey))]};
  this.db.prepare("INSERT INTO deletion_markers (id,scope_key,revision,source_id,parent_id,state,payload) VALUES(?,?,?,NULL,NULL,'forgotten',?)")
   .run(id,scope,view.revision,this.codec.seal("deletion_markers",scope,id,marker));
 }
}
