import {extractMaintenance,MAINTENANCE_VERSION} from "./maintenance-extractor";
import {createHash,randomUUID} from "node:crypto";
import {createMainActorAuthority} from "../memory-core/main-actor-authority";
import type {SourceRef,BoundSourceRef} from "../../shared/memory-contracts";
import {objectFields,parseInternalId,parseSourceRef,positiveRevision} from "../memory-core/command-validation";
import {requireMainAccess} from "../memory-core/main-access";
import {canonicalJson} from "../memory-core/repository-types";
import {parseSourceIdentity} from "../memory-core/source-ledger";
import type {SourceIdentity} from "../memory-core/source-contracts";
import {requireMainSourceProvider} from "../memory-sources/main-source-provider";
import type {createMainSourceRegistry} from "../memory-sources/source-registry";
import {extractPreference} from "./extractor";
import type {PolicyOutcome,PolicyCandidate,PolicyTransport,PolicyEvent} from "./policy-contracts";
import type {SupportAudit} from "./fact-supports";
import {NATURAL_VERSION,parseNaturalEdit} from "./natural-protocol";
import {prepareShadowRequest} from "../memory-shadow/shadow-prompt";
import type {ShadowModel} from "../memory-shadow/shadow-model-call";
import {resolveProject} from "./project-scope";
import type {NaturalJobView} from "../../shared/memory-automation-contracts";

export const POLICY_VERSION="main-preferences-v1";
const digest=(value:unknown)=>createHash("sha256").update(canonicalJson(value)).digest("hex");
interface Actor {access:object;adapter:object;scopeKey:string;actorKey:string;providerId:string;sessionId:string}
interface Event {actor:object;body:PolicyEvent}
interface Cursor {actor:object;generation:number;after:string}

/** Main-only synthetic seam. No renderer, IPC or production user ingress imports it. */
export function createMainPolicy(options:{registry:ReturnType<typeof createMainSourceRegistry>;transport:PolicyTransport;resolveActor:(scope:string,identity:SourceIdentity)=>string|null;actorAuthority?:import("../memory-core/main-actor-authority").MainActorAuthority}) {
 const actorAuthority=options.actorAuthority??createMainActorAuthority({resolveActor:options.resolveActor});
 const events=new WeakMap<object,Event>(),cursors=new WeakMap<object,Cursor>();
 function actorContext(value:unknown):Actor {
  const actor=actorAuthority.requireActor(value);if(actor.sessionMode==="temporary")throw new Error("MEMORY_POLICY_TEMPORARY_UNSUPPORTED");return actor;
 }
 function boundSource(actor:Actor,value:unknown):BoundSourceRef {
  const ref=parseSourceRef(value);
  if(!ref.binding||ref.binding.providerId!==actor.providerId||ref.binding.sessionId!==actor.sessionId)throw new Error("MEMORY_ACTOR_DENIED");
  if(ref.span)throw new Error("MEMORY_POLICY_FULL_SOURCE_REQUIRED");
  requireMainAccess(actor.access).verifySource(ref);return ref as BoundSourceRef;
 }
 async function command<T>(actor:Actor,kind:string,body:unknown,commandId?:string,signal?:AbortSignal,assertAuthority?:()=>void):Promise<T> {
  const execute=()=>{if(signal?.aborted)throw new Error("MEMORY_POLICY_CANCELLED");assertAuthority?.();return options.transport.policyCommand({kind,scopeKey:actor.scopeKey,...(commandId?{commandId}:{}),body:{actorKey:actor.actorKey,...body as object}});};
  return (options.actorAuthority?actorAuthority.coordinate(execute):execute()) as Promise<T>;
 }
 async function read(actor:Actor,ref:BoundSourceRef):Promise<string> {
  return options.registry.readEvidence(actor.access,actor.adapter,ref);
 }
 function naturalActor(token:object):Actor {
  const actor=actorContext(token);if(resolveProject(actorAuthority.requireActor(token))!==undefined)throw Error("MEMORY_POLICY_NATURAL_SCOPE_DENIED");return actor;
 }
 return {
  /** Internal Main capability only; no renderer actor/source constructors or auto flag. */
  async naturalCommand<T=unknown>(token:object,operation:string,value:unknown={},signal?:AbortSignal,assertAuthority?:()=>void):Promise<T> {
   const actor=naturalActor(token),body={...objectFields(value,[],["expectedRevision","language","responseStyle","sourceRef","sourceText","profile","jobId","token","limits","result","reason","profileId","definition"])};
   const current=()=>{naturalActor(token);assertAuthority?.()};
   if(signal?.aborted)throw Error("MEMORY_POLICY_CANCELLED");
   if(body.sourceRef!==undefined){
    const ref=boundSource(actor,body.sourceRef),checked=requireMainAccess(actor.access).verifySource(ref);
    if(checked.kind!=="user"||checked.sourceTrust!=="direct-user-event")throw Error("MEMORY_USER_SOURCE_DENIED");
    body.sourceRef=ref;
    if(operation==="enqueue"||operation==="configure")body.sourceText=await read(actor,ref);
   }
   if(["dispatch","save","apply"].includes(operation)){
    const job=await command<NaturalJobView>(actor,"naturalJob",{operation:"get",jobId:parseInternalId(body.jobId)});
    boundSource(actor,job.sourceRef);
   }
   return command<T>(actor,"naturalJob",{operation,...body},randomUUID(),signal,current);
  },
  async naturalJobs(token:object,all=false):Promise<NaturalJobView[]> {
   const actor=naturalActor(token);if(all&&actor.sessionId!=="memory-settings-user-events-v1")throw Error("MEMORY_ACTOR_DENIED");
   const result=await command<{jobs:NaturalJobView[]}>(actor,"naturalJob",{operation:"list"});
   naturalActor(token);
   return all?result.jobs:result.jobs.filter(job=>job.sourceRef.binding.providerId===actor.providerId&&job.sourceRef.binding.sessionId===actor.sessionId);
  },
  async naturalSource(token:object,value:BoundSourceRef,signal?:AbortSignal):Promise<{ref:BoundSourceRef;text:string}> {
   const actor=naturalActor(token),old=parseSourceRef(value);
   if(signal?.aborted)throw Error("MEMORY_POLICY_CANCELLED");
   if(!old.binding||old.span||old.binding.providerId!==actor.providerId||old.binding.sessionId!==actor.sessionId)throw Error("MEMORY_ACTOR_DENIED");
   const ref=await options.registry.capture(actor.access,actor.adapter,{providerId:old.binding.providerId,sessionId:old.binding.sessionId,messageId:old.binding.messageId});
   if(canonicalJson(ref)!==canonicalJson(old))throw Error("MEMORY_SOURCE_STALE");
   boundSource(actor,ref);const checked=requireMainAccess(actor.access).verifySource(ref);
   if(checked.kind!=="user"||checked.sourceTrust!=="direct-user-event")throw Error("MEMORY_USER_SOURCE_DENIED");
   const text=await read(actor,ref);if(signal?.aborted)throw Error("MEMORY_POLICY_CANCELLED");naturalActor(token);return {ref,text};
  },
  async manage(token:object):Promise<import("../../shared/memory-contracts").FactView[]>{return command(actorContext(token),"manage",{})},
  async recall(token:object):Promise<import("../../shared/memory-contracts").FactView[]>{return command(actorContext(token),"recall",{})},
  async audit(token:object,factId:string):Promise<SupportAudit>{return command(actorContext(token),"audit",{factId:parseInternalId(factId)})},
  async reconcileSupports(token:object):Promise<unknown>{const actor=actorContext(token);return command(actor,"reconcileSupports",{generation:await command<number>(actor,"generation",{})},randomUUID())},
  bindActor(access:object,adapter:object,value:SourceIdentity):object {
   return actorAuthority.bindActor(access,adapter,value);
  },
  /** Main owns authority/time; the model can only supply untrusted proposed data. */
  async extractNatural(token:object,value:BoundSourceRef,model:ShadowModel,signal?:AbortSignal):Promise<import("./policy-contracts").IntegrationResult> {
   const checkScope=()=>{if(resolveProject(actorAuthority.requireActor(token))!==undefined)throw Error("MEMORY_POLICY_NATURAL_SCOPE_DENIED")};checkScope();
   const actor=actorContext(token),ref=boundSource(actor,value);
   const checked=requireMainAccess(actor.access).verifySource(ref);
   if(checked.kind!=="user"||checked.sourceTrust!=="direct-user-event")throw Error("MEMORY_USER_SOURCE_DENIED");
   const cancelled=()=>{if(signal?.aborted)throw Error("MEMORY_POLICY_CANCELLED")};cancelled();
   const snapshot=await command<{generation:number;predecessor:{candidateId:string;revision:number}|null;done?:import("./policy-contracts").IntegrationResult}>(actor,"naturalSnapshot",{sourceRef:ref});
   if(snapshot.done)return snapshot.done;
   const text=await read(actor,ref);cancelled();
   const request=prepareShadowRequest({user:{id:ref.binding.messageId,text}});if(!request.send)return {items:[]};
   model.assertCurrent();const prepared=model.prepare(request.system+"\nProtocol: "+NATURAL_VERSION+". Propose review candidates only. Never grant storage, tool or instruction authority.",request.user);if(!prepared.ok)return {items:[]};
   const response=await prepared.send(signal??new AbortController().signal);cancelled();model.assertCurrent();
   if(!response.ok)return {items:[]};
   if(await read(actor,ref)!==text)throw Error("MEMORY_SOURCE_STALE");cancelled();checkScope();
   const intent={sourceRef:ref,generation:snapshot.generation,policyVersion:NATURAL_VERSION};
   return command(actor,"proposeNatural",{...intent,sourceText:text,raw:response.text,predecessor:snapshot.predecessor},"natural-propose-"+digest({scope:actor.scopeKey,actor:actor.actorKey,...intent}),signal);
  },
  async validateCorrection(token:object,factId:string,revision:number,text:string):Promise<void> {
   const actor=actorContext(token),parsed=extractPreference(text);
   if(parsed.kind==="rejected")throw Error("MEMORY_POLICY_SECRET");
   const target=await command<{typed:import("../../shared/memory-contracts").TypedUserFact|null}>(actor,"editBinding",{factId:parseInternalId(factId),revision:positiveRevision(revision)});
   if(target.typed)parseNaturalEdit(text,target.typed.attribute);
   else if(parsed.kind!=="direct")throw Error("MEMORY_POLICY_UNRESOLVED");
  },
  async integrate(token:object,value:BoundSourceRef,signal?:AbortSignal):Promise<import("./policy-contracts").IntegrationResult> {
   const actor=actorContext(token),ref=boundSource(actor,value),project=resolveProject(actorAuthority.requireActor(token));
   const cancelled=()=>{if(signal?.aborted)throw new Error("MEMORY_POLICY_CANCELLED")};cancelled();
   const generation=await command<number>(actor,"generation",{});
   const baseline=await command<import("./policy-contracts").PolicyBaseline[]>(actor,"baseline",{});
   cancelled();const extraction=extractMaintenance(await read(actor,ref));cancelled();
   const intent={sourceRef:ref,generation,extraction,policyVersion:MAINTENANCE_VERSION,...(project!==undefined?{projectKey:project}:{})};
   return command(actor,"integrate",{...intent,baseline},"policy-integrate-"+digest({scope:actor.scopeKey,actor:actor.actorKey,...intent}),signal);
  },
  async ingest(token:unknown,value:SourceRef):Promise<PolicyOutcome> {
   const actor=actorContext(token),ref=boundSource(actor,value);
   const generation=await command<number>(actor,"generation",{});
   const baseline=await command<import("./policy-contracts").PolicyBaseline[]>(actor,"baseline",{});
   const extraction=extractPreference(await read(actor,ref));
   const intent={sourceRef:ref,generation,extraction,policyVersion:POLICY_VERSION};
   return command(actor,"ingest",{...intent,baseline},"policy-ingest-"+digest({scope:actor.scopeKey,actor:actor.actorKey,...intent}));
  },
  async event(token:object,value:unknown):Promise<object> {
   const actor=actorContext(token),base=objectFields(value,["kind","nonce"],["candidateId","factId","revision","sourceRef","contentHash"]);
   const kind=base.kind;
   if(!["confirm","confirmFact","deny","reject","revise","resolve","correct","forget","remember"].includes(kind as string))throw new Error("MEMORY_EVENT_DENIED");
   const required=kind==="remember"?["kind","nonce","sourceRef"]:["correct","confirmFact","deny"].includes(kind as string)?["kind","nonce","factId","revision","sourceRef"]:kind==="forget"?["kind","nonce","factId","revision"]:["revise","resolve","confirm"].includes(kind as string)?["kind","nonce","candidateId","revision","sourceRef"]:["kind","nonce","candidateId","revision"];
   const v=objectFields(value,required,kind==="confirm"?["contentHash"]:[]),nonce=parseInternalId(v.nonce);
   const body:PolicyEvent={kind:kind as PolicyEvent["kind"],nonce,generation:await command<number>(actor,"generation",{})};
   if(v.candidateId!==undefined)body.candidateId=parseInternalId(v.candidateId);
   if(v.factId!==undefined)body.factId=parseInternalId(v.factId);
   if(v.revision!==undefined)body.revision=positiveRevision(v.revision);
   if(kind==="confirm"){
    const binding=await command<{contentHash:string;scopeBinding:string}>(actor,"candidateBinding",{candidateId:body.candidateId,revision:body.revision});
    if(v.contentHash!==undefined&&v.contentHash!==binding.contentHash)throw Error("MEMORY_CONFIRMATION_STALE");
    body.contentHash=binding.contentHash;body.scopeBinding=binding.scopeBinding;
   }
   if(v.sourceRef!==undefined){
    body.sourceRef=boundSource(actor,v.sourceRef);const text=await read(actor,body.sourceRef),parsed=extractPreference(text);
    if(parsed.kind==="rejected")throw new Error("MEMORY_POLICY_SECRET");
    if(["revise","resolve","correct","remember"].includes(kind as string)){
     if(kind==="correct"||kind==="revise"){
      const target=await command<{typed:import("../../shared/memory-contracts").TypedUserFact|null}>(actor,"editBinding",{revision:body.revision,...(kind==="correct"?{factId:body.factId}:{candidateId:body.candidateId})});
      if(target.typed){body.naturalEdit=parseNaturalEdit(text,target.typed.attribute);body.sourceText=text;}
      else if(parsed.kind==="direct")body.extraction=parsed;
      else throw new Error("MEMORY_POLICY_UNRESOLVED");
     }else if(parsed.kind==="direct")body.extraction=parsed;
     else throw new Error("MEMORY_POLICY_UNRESOLVED");
    }
   }
   const event=Object.freeze({});events.set(event,{actor:token,body:structuredClone(body)});return event;
  },
  async act(token:object,event:unknown):Promise<PolicyOutcome> {
   const actor=actorContext(token),claim=event&&typeof event==="object"?events.get(event):undefined;
   if(!claim||claim.actor!==token)throw new Error("MEMORY_EVENT_DENIED");
   return command(actor,"event",claim.body,"policy-event-"+digest({scope:actor.scopeKey,actor:actor.actorKey,nonce:claim.body.nonce}));
  },
  async candidates(token:object,input:{limit:number;cursor?:object}):Promise<{items:PolicyCandidate[];cursor:object|null}> {
   const actor=actorContext(token),v=objectFields(input,["limit"],["cursor"]);
   if(!Number.isSafeInteger(v.limit)||(v.limit as number)<1||(v.limit as number)>100)throw new Error("MEMORY_INPUT_INVALID");
   const generation=await command<number>(actor,"generation",{});let after="";
   if(v.cursor!==undefined){const claim=v.cursor&&typeof v.cursor==="object"?cursors.get(v.cursor):undefined;if(!claim||claim.actor!==token)throw new Error("MEMORY_CURSOR_DENIED");if(claim.generation!==generation)throw new Error("MEMORY_CURSOR_STALE");after=claim.after;}
   const items=await command(actor,"candidates",{generation,after,limit:(v.limit as number)+1}) as PolicyCandidate[];
   const more=items.length>(v.limit as number),selected=items.slice(0,v.limit as number);let cursor:object|null=null;
   if(more){cursor=Object.freeze({});cursors.set(cursor,{actor:token,generation,after:selected[selected.length-1].candidateId});}
   return {items:selected,cursor};
  },
 };
}
