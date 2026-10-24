import fs from "node:fs";
import path from "node:path";
import {randomUUID} from "node:crypto";
import {canonicalJson} from "../../../src/main/memory-core/repository-types";
import type {SourceIdentity,SourceRole,SourceTrust} from "../../../src/main/memory-core/source-contracts";
import {createMainSourceProvider,type SourceSnapshot} from "../../../src/main/memory-sources/main-source-provider";

/** Synthetic file-backed provider only. Never opens chatsStore or application userData. */
export class SyntheticSourceProvider {
 readonly adapter:object;
 failReads=false;
 afterNextRead:(()=>void)|undefined;
 private readonly entries:Record<string,SourceSnapshot>;
 private readonly leases=new Set<string>();
 private racing=false;
 constructor(private readonly file:string,scope:string){
  this.entries=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,"utf8")):{};
  this.adapter=createMainSourceProvider({providerId:"synthetic",authorize:s=>s===scope,withLease:async(identity,operation)=>{
   const id=canonicalJson(identity);if(this.leases.has(id))throw new Error("SYNTHETIC_LEASE_BUSY");
   this.leases.add(id);
   try{return await operation(async()=>{
    if(this.failReads)throw new Error("SYNTHETIC_READ_FAILED");
    const entry=this.entries[id];if(!entry)throw new Error("SYNTHETIC_NOT_FOUND");const copy=structuredClone(entry);
    const hook=this.afterNextRead;this.afterNextRead=undefined;
    if(hook){this.racing=true;try{hook()}finally{this.racing=false}}
    return copy;
   })}finally{this.leases.delete(id)}
  }});
 }
 private save(){fs.mkdirSync(path.dirname(this.file),{recursive:true});const staging=this.file+".tmp";fs.writeFileSync(staging,JSON.stringify(this.entries));fs.renameSync(staging,this.file)}
 private mutable(identity:SourceIdentity):string {const id=canonicalJson(identity);if(this.leases.has(id)&&!this.racing)throw new Error("SYNTHETIC_LEASE_BUSY");return id}
 write(identity:SourceIdentity,content:{text:string;role:SourceRole;trust:SourceTrust;occurredAt?:number}){
  const id=this.mutable(identity),old=this.entries[id],fresh=!old||old.state==="deleted";
  const unchanged=old&&old.state==="live"&&old.text===content.text&&old.role===content.role&&old.trust===content.trust&&old.occurredAt===content.occurredAt;
  this.entries[id]={...identity,...content,state:"live",generation:fresh?randomUUID():old.generation,contentRevision:fresh?1:unchanged?old.contentRevision:old.contentRevision+1};this.save();
 }
 remove(identity:SourceIdentity){const id=this.mutable(identity),old=this.entries[id];if(!old)throw new Error("SYNTHETIC_NOT_FOUND");this.entries[id]={...old,text:"",state:"deleted",contentRevision:old.contentRevision+1};this.save()}
 metadata(_identity:SourceIdentity,_metadata:{title?:string;tts?:string}){this.save()}
}
