import {createHash,randomUUID} from "node:crypto";
import type {MainDesktopSessionAuthority} from "../memory-context/main-desktop-session-authority";
import type {SourceIdentity,SourceObservation} from "../memory-core/source-contracts";
import {parseSourceIdentity,parseSourceTimeZone} from "../memory-core/source-ledger";
import {parseInternalId} from "../memory-core/command-validation";
import {canonicalJson} from "../memory-core/repository-types";
import {createMainSourceProvider,type SourceSnapshot} from "./main-source-provider";
interface Options {
 authority:MainDesktopSessionAuthority;providerId:string;scopeKey:string;
 readUser:(identity:SourceIdentity)=>{role:string;text:string}|null;
 clock:()=>number;
 timeZone?:()=>string;
 /** Main-owned profile storage, never an IPC principal. Only encrypted published heads restore provenance. */
 isOwnedSession?:(sessionId:string)=>boolean;
 /** Canonical committed replace_user entry; metadata history alone cannot admit an edit. */
 readCommittedEdit?:(identity:SourceIdentity)=>Promise<{revision:number;text:string}|null>;
}
interface Admission {grant:object;identity:SourceIdentity}
const denied=():never=>{throw Error("MEMORY_USER_SOURCE_DENIED")};
const fingerprint=(text:string,state:"live"|"deleted"="live")=>createHash("sha256").update(canonicalJson({text,state,role:"user",trust:"direct-user-event"})).digest("hex");
/** Original direct events are admitted by Main before a fresh user append; history never mints receipts. */
export function createDesktopUserSourceProvider(options:Options){
 const providerId=parseInternalId(options.providerId),scopeKey=parseInternalId(options.scopeKey),sessions=new Set<string>();
 const admissions=new WeakMap<object,Admission>(),receipts=new Map<string,SourceSnapshot>(),admitted=new Set<string>();
 const key=(id:SourceIdentity)=>canonicalJson(id);
 const timeZone=()=>parseSourceTimeZone(options.timeZone?.()??Intl.DateTimeFormat().resolvedOptions().timeZone);
 let tail:Promise<unknown>=Promise.resolve();
 /** Metadata mutations only; registry/Worker calls must occur after this operation releases. */
 function mutate<T>(operation:()=>T|Promise<T>):Promise<T>{const result=tail.then(operation);tail=result.catch(()=>undefined);return result}

 function attachSession(grant:object,conversationId:string){const binding=options.authority.require(grant,conversationId);if(binding.scopeKey!==scopeKey)return denied();sessions.add(conversationId)}
 const token=createMainSourceProvider({providerId,authorize:(scope,id)=>scope===scopeKey&&id.providerId===providerId&&(sessions.has(id.sessionId)||options.isOwnedSession?.(id.sessionId)===true),
  async withLease<T>(identity:SourceIdentity,operation:(read:()=>Promise<SourceSnapshot>)=>Promise<T>,previous?:Readonly<SourceObservation>):Promise<T>{
   const id=parseSourceIdentity(identity);
   return mutate(()=>operation(async()=>{
    const receipt=receipts.get(key(id)),user=options.readUser(id);
    if(receipt){
     if(user?.role==="user"&&user.text===receipt.text)return structuredClone(receipt);
     return {...receipt,state:"deleted",text:"",contentRevision:receipt.contentRevision+1};
    }
    // Metadata comes only from an authenticated encrypted Worker head. Restore original
    // provenance only when current bytes match; no historical role inference or backfill.
    if(!previous||previous.state!=="live"||previous.role!=="user"||previous.trust!=="direct-user-event")return denied();
    const unchanged=user?.role==="user"&&typeof user.text==="string"&&fingerprint(user.text)===previous.fingerprint;
    return {...id,generation:previous.generation,contentRevision:previous.contentRevision+(unchanged?0:1),role:"user",trust:"direct-user-event",state:unchanged?"live":"deleted",text:unchanged?user!.text:"",...(previous.occurredAt===undefined?{}:{occurredAt:previous.occurredAt}),...(previous.timeZone===undefined?{}:{timeZone:previous.timeZone})};
   }));
  },
 });
 return Object.freeze({token,attachSession,mutate,
  async commitUserEdit(grant:object,conversationId:string,messageId:string):Promise<void> {
   attachSession(grant,conversationId);const identity=parseSourceIdentity({providerId,sessionId:conversationId,messageId});
   await mutate(async()=>{
    options.authority.require(grant,conversationId);const edit=await options.readCommittedEdit?.(identity),user=options.readUser(identity);
    options.authority.require(grant,conversationId);const occurredAt=options.clock(),previous=receipts.get(key(identity));
    if(!edit||!Number.isSafeInteger(edit.revision)||edit.revision<2||!user||user.role!=="user"||user.text!==edit.text||!Number.isSafeInteger(occurredAt)||occurredAt<0)return denied();
    if(previous?.contentRevision===edit.revision&&previous.text===edit.text)return;
    if(previous&&previous.contentRevision>=edit.revision)return denied();
    receipts.set(key(identity),Object.freeze({...identity,text:edit.text,role:"user",trust:"direct-user-event",state:"live",contentRevision:edit.revision,generation:randomUUID(),occurredAt,timeZone:timeZone()}));
   });
  },
  prepareUserCommit(grant:object,conversationId:string,messageId:string):object {
   attachSession(grant,conversationId);const identity=parseSourceIdentity({providerId,sessionId:conversationId,messageId});
   if(options.readUser(identity)!==null||receipts.has(key(identity))||admitted.has(key(identity)))return denied();
   const ticket=Object.freeze({});admitted.add(key(identity));admissions.set(ticket,{grant,identity});return ticket;
  },
  /** Release a failed preparation only while no user bytes or receipt were committed.
   * Never undoes persisted metadata, finished receipts, or a consumed/unknown outcome. */
  cancelUserCommit(ticket:object):void {
   const admission=ticket&&typeof ticket==="object"?admissions.get(ticket):undefined;if(!admission)return denied();
   if(options.readUser(admission.identity)!==null||receipts.has(key(admission.identity)))return denied();
   admissions.delete(ticket);admitted.delete(key(admission.identity));
  },
  finishUserCommit(ticket:object):void {
   const admission=ticket&&typeof ticket==="object"?admissions.get(ticket):undefined;if(!admission)return denied();
   admissions.delete(ticket);options.authority.require(admission.grant,admission.identity.sessionId);
   const user=options.readUser(admission.identity),occurredAt=options.clock();
   if(!user||user.role!=="user"||typeof user.text!=="string"||!Number.isSafeInteger(occurredAt)||occurredAt<0)return denied();
   receipts.set(key(admission.identity),Object.freeze({...admission.identity,text:user.text,role:"user",trust:"direct-user-event",state:"live",contentRevision:1,generation:randomUUID(),occurredAt,timeZone:timeZone()}));
  },
 });
}
