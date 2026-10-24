import type {IpcMainInvokeEvent} from "electron";
import type {ChatMessage,ChatSession} from "../../shared/chat-types";
import type {FireflyRunOptions} from "../orchestrator/firefly-agent";
import type {ChatRequest} from "../orchestrator/vendors/types";
import type {MemoryClient} from "../memory-core/worker-client";
import {createMainActorAuthority} from "../memory-core/main-actor-authority";
import {createMainSourceRegistry} from "../memory-sources/source-registry";
import {createDesktopUserSourceProvider} from "../memory-sources/desktop-user-source-provider";
import {createNativeHistoryProvider} from "../memory-sources/native-history-provider";
import type {NativeHistoryEndpointFactory} from "../memory-sources/native-history-transport";
import {createMainPolicy} from "../memory-policy/main-policy";
import {createMainRecall} from "../memory-recall/main-recall";
import {createMainHistory} from "../memory-history/main-history";
import {createHistoryBudgetStatsRecorder} from "../memory-history/history-budget-stats";
import {getStorageContext} from "../storage/storage-context";
import {createMainUserFactCoordinator} from "../memory-policy/main-user-fact-coordinator";
import {createMainFactSelector} from "../memory-recall/main-fact-selector";
import {createConversationTranscriptAdapter} from "./conversation-transcript-adapter";
import {createMainDesktopSessionAuthority} from "./main-desktop-session-authority";
import {createMainSRuntimePort,type MainSRuntimePort} from "./main-s-runtime-port";
import type {createMainResponsesBinding} from "./main-responses-binding";
import type {ConversationTranscriptStore} from "../orchestrator/conversation-transcript-store";

type AuthorityOptions=Parameters<typeof createMainDesktopSessionAuthority>[0];
export interface DesktopMemoryBackend {
 transport:Pick<MemoryClient,"sourceCommand"|"policyCommand"|"recallCommand"|"historyCommand"|"contextCommand">;
 binding:NonNullable<ReturnType<typeof createMainResponsesBinding>>;
 localRetrieval?:Parameters<typeof createMainHistory>[0]["localRetrieval"];
 endpointFactory:NativeHistoryEndpointFactory;
 request:(options:FireflyRunOptions)=>ChatRequest;
 close:()=>Promise<void>;
}
interface Options extends Pick<AuthorityOptions,"enabled"|"getChatWindow"|"targets"> {
 getSession:(id:string)=>ChatSession|undefined|null;listSessionIds:()=>string[];
 isControlledSession:(session:ChatSession)=>boolean;
 store:ConversationTranscriptStore;openBackend:()=>Promise<DesktopMemoryBackend>;clock?:()=>number;
}
const SCOPE="desktop-local-profile-v1",ACTOR="desktop-local-user-v1",PROVIDER="desktop-chat-user-v1";
type Event=Pick<IpcMainInvokeEvent,"sender"|"senderFrame">;
function fail():never{throw Error("MEMORY_DESKTOP_SESSION_DENIED")}
/** Main startup owns this one composition and its lifecycle. All tokens stay in Main. */
export function createMainDesktopMemory(options:Options){
 if(options.enabled!==true)return null;
 const knownSessions=new Set<string>();
 const clock=options.clock??Date.now,owned=(id:string)=>{const session=options.getSession(id);const selected=!!session&&session.mode==="chat"&&options.isControlledSession(session)===true;if(selected)knownSessions.add(id);return !!session&&session.mode==="chat"&&(selected||knownSessions.has(id))};
 const authority=createMainDesktopSessionAuthority({...options,scopeKey:SCOPE,actorKey:ACTOR,isControlledSession:session=>{const stored=options.getSession(session.id);return !!stored&&options.isControlledSession(stored)===true}})!;
 const readUser=(identity:{sessionId:string;messageId:string})=>{
  const matches=options.getSession(identity.sessionId)?.messages.filter(m=>m.id===identity.messageId);if(matches?.length!==1)return null;
  const m=matches[0];return m.role==="user"&&typeof m.content==="string"&&!m.modelContext&&!m.attachments?.length?{role:"user",text:m.content}:null;
 };
 const source=createDesktopUserSourceProvider({authority,providerId:PROVIDER,scopeKey:SCOPE,readUser,clock,isOwnedSession:id=>owned(id)||knownSessions.has(id),readCommittedEdit:async identity=>{
  const entries=(await options.store.read(identity.sessionId)).entries,entry=entries.filter(e=>e.kind==="turn_rewind"&&e.payload.anchorUserTurnId===identity.messageId).at(-1);
  return entry?.kind==="turn_rewind"&&entry.payload.disposition==="replace_user"&&entry.payload.reason==="edit"&&entry.revision&&entry.payload.replacementUser&&!entry.payload.replacementUser.attachments?.length?{revision:entry.revision,text:entry.payload.replacementUser.text}:null;
 }});
 const runs=new Map<string,{grant:object;users:number}>();
 type RecordState={actor:object;native:ReturnType<typeof createNativeHistoryProvider>;adapter?:NonNullable<ReturnType<typeof createConversationTranscriptAdapter>>;port?:MainSRuntimePort};
 const activePorts=new Set<Promise<unknown>>();
 const records=new Map<string,RecordState>();let closing=false,closed:Promise<void>|undefined;
 let resolvedBackend:DesktopMemoryBackend|undefined;
 let boot:Promise<Awaited<ReturnType<typeof initialize>>>|undefined;
 async function initialize(){
  const backend=await options.openBackend();
  try{
   if(closing)fail();
   const actorAuthority=createMainActorAuthority({resolveActor:(scope,id)=>scope===SCOPE&&id.providerId===PROVIDER&&owned(id.sessionId)?ACTOR:null});
   const registry=createMainSourceRegistry(backend.transport,{coordinate:actorAuthority.coordinate}),access=registry.authority.access(SCOPE);
   const policy=createMainPolicy({registry,transport:backend.transport,actorAuthority,resolveActor:()=>ACTOR}),recall=createMainRecall({actorAuthority,transport:backend.transport});
   const history=createMainHistory({actorAuthority,registry,transport:backend.transport,localRetrieval:backend.localRetrieval,onBudgetStats:createHistoryBudgetStatsRecorder(()=>getStorageContext().files.historyBudgetStats).record});
   const coordinator=createMainUserFactCoordinator({actorAuthority,registry,policy}),selector=createMainFactSelector({actorAuthority,registry,policy,recall});
   resolvedBackend=backend;return {backend,actorAuthority,registry,access,policy,history,coordinator,selector};
  }catch(error){await backend.close();throw error}
 }
 function resources(){if(closing)fail();return boot??(boot=initialize())}
 function requireRun(id:string){const run=runs.get(id);if(!run||closing)fail();authority.require(run.grant,id);return run.grant}
 function bind(event:Event,id:string){if(closing)fail();const grant=authority.bind(event,id);source.attachSession(grant,id);return grant}
 async function record(id:string){
  const core=await resources();let state=records.get(id);if(state)return state;
  const actor=core.actorAuthority.bindActor(core.access,source.token,{providerId:PROVIDER,sessionId:id,messageId:"main-actor-binding"});
  const native=createNativeHistoryProvider({actorAuthority:core.actorAuthority,actorToken:actor,store:options.store,history:core.history,endpointFactory:core.backend.endpointFactory,deadlineMs:30000});
  state={actor,native};records.set(id,state);return state;
 }
 let mutations:Promise<unknown>=Promise.resolve();
 function serialized<T>(operation:()=>Promise<T>):Promise<T>{const result=mutations.then(operation);mutations=result.catch(()=>undefined);return result}
 async function reconcile(id:string,messageId:string){const core=await resources();try{await core.registry.reconcile(core.access,source.token,{providerId:PROVIDER,sessionId:id,messageId})}catch(error){if(!(error instanceof Error)||!['MEMORY_SOURCE_DELETED','MEMORY_USER_SOURCE_DENIED'].includes(error.message))throw error}}
 return Object.freeze({
  refresh:authority.refresh,ownsSession:owned,
  quiesce(){closing=true;authority.dispose();runs.clear()},
  authorizeRun(event:Event,id:string){if(!owned(id))return undefined;const grant=bind(event,id),binding=authority.require(grant,id),current=runs.get(id);if(current&&current.grant!==grant)fail();const state=current??{grant,users:0};state.users++;runs.set(id,state);let released=false;return Object.freeze({signal:binding.signal,release(){if(released)return;released=true;if(--state.users===0&&runs.get(id)===state)runs.delete(id)}})},
  async afterTranscript(id:string,input:{userTurnId?:string;transcriptRewind?:{disposition:string}}){
   if(!owned(id))return;const grant=requireRun(id);if(input.transcriptRewind?.disposition==='replace_user'&&input.userTurnId){await source.commitUserEdit(grant,id,input.userTurnId);const core=await resources();await core.registry.capture(core.access,source.token,{providerId:PROVIDER,sessionId:id,messageId:input.userTurnId})}
  },
  async appendUser<T>(event:Event,id:string,message:ChatMessage,commit:()=>T):Promise<T>{
   if(!owned(id))return commit();return serialized(async()=>{
    const grant=bind(event,id);if(message.role!=="user"||!message.id||typeof message.content!=="string"||message.modelContext||message.attachments?.length)throw Error("MEMORY_USER_SOURCE_DENIED");
    const core=await resources();authority.require(grant,id);
    const result=await source.mutate(()=>{const ticket=source.prepareUserCommit(grant,id,message.id),value=commit();source.finishUserCommit(ticket);return value});
    await core.registry.capture(core.access,source.token,{providerId:PROVIDER,sessionId:id,messageId:message.id});return result;
   });
  },
  async mutate<T>(event:Event,id:string,changedUsers:string[],commit:()=>T):Promise<T>{
   if(!owned(id))return commit();return serialized(async()=>{
    const active=options.targets.getActive();if(!active)fail();const grant=bind(event,active.sessionId),core=await resources();
    for(const messageId of new Set(changedUsers))await core.registry.prepareIdentityChange(core.access,source.token,{providerId:PROVIDER,sessionId:id,messageId});
    if(changedUsers.length)await records.get(id)?.native.invalidate('history-remove');
    authority.require(grant,active.sessionId);const result=await source.mutate(commit);
    for(const messageId of new Set(changedUsers))await reconcile(id,messageId);return result;
   });
  },
  sContext:{enabled:true,isControlledSession:(id:string)=>{try{requireRun(id);return owned(id)}catch{return false}},
   async createPort(scope?:Readonly<{conversationId:string}>):Promise<MainSRuntimePort>{
    if(!scope)fail();const id=scope.conversationId;requireRun(id);const core=await resources(),state=await record(id);requireRun(id);
    if(!state.port){
     const port=createMainSRuntimePort({enabled:true,clock,registry:core.registry,transport:core.backend.transport,actorAuthority:core.actorAuthority,actorToken:state.actor,binding:core.backend.binding,
      facts:{currentUserSource:async current=>{requireRun(id);return core.registry.capture(core.access,source.token,{providerId:PROVIDER,sessionId:id,messageId:current.userTurnId})},coordinator:core.coordinator,selector:core.selector,limits:{maxFacts:8}},
      history:{query:async(current,signal)=>{
       requireRun(id);const selected=[id,...options.listSessionIds().filter(other=>other!==id&&owned(other)&&options.getSession(other)?.messages.some(message=>message.role==="user"))];if(selected.length>32)throw Error("MEMORY_HISTORY_ACCESS_DENIED");
       const actors:object[]=[];let forgotten=false;
       for(const other of selected){const historical=await record(other);if(other===id)await options.store.checkpoint(id);const outcome=await historical.native.capture(signal);if(outcome.status!=='captured'){if(['disabled-by-forget','disabled-by-retraction'].includes(outcome.reason)){forgotten=true;continue}throw Error("MEMORY_HISTORY_COVERAGE_INSUFFICIENT")}if(other!==id)actors.push(historical.actor)}
       requireRun(id);if(forgotten&&!actors.length)return [];const partition=core.history.grantSessions(state.actor,actors);return [(await core.history.query(state.actor,{query:current.userText,scope:partition,signal})).evidence];
      }},
      createTranscript:context=>(state.adapter=createConversationTranscriptAdapter({enabled:true,store:options.store,actorAuthority:core.actorAuthority,actorToken:state.actor,context,beforeMutation:(kind,entry,ticket)=>state.native.beforeMutation(kind,entry,ticket)})!)});
     if(!port)fail();state.port={run:input=>{const grant=requireRun(id),binding=authority.require(grant,id);const pending=port.run({...input,signal:input.signal?AbortSignal.any([input.signal,binding.signal]):binding.signal});activePorts.add(pending);void pending.then(()=>activePorts.delete(pending),()=>activePorts.delete(pending));return pending}};
    }
    return state.port;
   },
   streamRequest:(input:FireflyRunOptions)=>{if(!input.conversationId)fail();requireRun(input.conversationId);if(!boot)fail();const core=records.get(input.conversationId);if(!core?.port)fail();return request(input)},
  },
  close(){if(!closed){closing=true;authority.dispose();runs.clear();closed=(async()=>{
   await mutations;const core=await boot?.catch(()=>undefined);if(!core)return;
   const results=await Promise.allSettled([...records.values()].map(async state=>{await state.native.close();await state.adapter?.close()}));
   await Promise.allSettled([...activePorts]);
   if(results.some(r=>r.status==='rejected'))throw Error("MEMORY_DESKTOP_CLEANUP_FAILED");await core.backend.close();
  })()}return closed},
 });
 // request is installed only by successful resource initialization, never from renderer input.
 function request(input:FireflyRunOptions):ChatRequest {if(!resolvedBackend)fail();return resolvedBackend.request(input)}
}

export type MainDesktopMemory=NonNullable<ReturnType<typeof createMainDesktopMemory>>;
