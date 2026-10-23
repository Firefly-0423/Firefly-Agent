import type {BrowserWindow,IpcMainInvokeEvent,WebContents,WebFrameMain} from "electron";
import type {ActiveChatTarget,ActiveChatTargetRegistry} from "../plugin-host/active-chat-target";
import {parseInternalId} from "../memory-core/command-validation";

export interface DesktopMemorySession {id:string;mode?:string;modelProfileId?:string}
export interface DesktopMemoryBinding {
 readonly conversationId:string;readonly scopeKey:string;readonly actorKey:string;
 readonly webContentsId:number;readonly signal:AbortSignal;
}
interface Options {
 enabled?:boolean;scopeKey:string;actorKey:string;
 /** Main composition opts ordinary Work/Code in; renderer cannot alter this set. */
 allowedModes?:readonly ("chat"|"work"|"code")[];
 getChatWindow:()=>Pick<BrowserWindow,"webContents"|"isDestroyed">|null;
 targets:Pick<ActiveChatTargetRegistry,"getActive"|"onInvalidated"|"onSessionDeleted">;
 getSession:(id:string)=>DesktopMemorySession|undefined|null;
 /** Main configuration only. IPC/session metadata cannot opt itself in. */
 isControlledSession:(session:DesktopMemorySession)=>boolean;
}
interface GrantState {target:ActiveChatTarget;sender:WebContents;frame:WebFrameMain;controller:AbortController;binding:DesktopMemoryBinding}
const denied=():never=>{throw Error("MEMORY_DESKTOP_SESSION_DENIED")};
/** Main-owned live window/session proof. Opaque tokens never enter IPC or model data. */
export function createMainDesktopSessionAuthority(options:Options){
 if(options.enabled!==true)return null;
 const scopeKey=parseInternalId(options.scopeKey),actorKey=parseInternalId(options.actorKey);
 const allowedModes=new Set<string>(options.allowedModes??["chat"]);
 if(!allowedModes.size||[...allowedModes].some(mode=>!["chat","work","code"].includes(mode)))return denied();
 const grants=new WeakMap<object,GrantState>(),states=new Set<GrantState>(),deleted=new Set<string>();
 let disposed=false,current:{token:object;state:GrantState}|undefined;
 function revoke(state:GrantState){state.controller.abort();states.delete(state);if(current?.state===state)current=undefined}
 function selected(sender:WebContents,frame:WebFrameMain,conversationId:string):ActiveChatTarget {
  if(disposed||deleted.has(conversationId))return denied();
  const window=options.getChatWindow(),target=options.targets.getActive();
  if(!window||window.isDestroyed()||sender.isDestroyed()||window.webContents!==sender||!frame||frame!==sender.mainFrame
   ||!target||target.webContentsId!==sender.id||target.sessionId!==conversationId||!allowedModes.has(target.mode))return denied();
  const session=options.getSession(conversationId);
  if(!session||session.id!==conversationId||session.mode!==target.mode||options.isControlledSession(session)!==true)return denied();
  return target;
 }
 function check(state:GrantState,conversationId:string){
  if(state.controller.signal.aborted||conversationId!==state.binding.conversationId)return denied();
  try{
   const target=selected(state.sender,state.frame,conversationId);
   if(target.rendererTargetId!==state.target.rendererTargetId)return denied();
  }catch(error){revoke(state);throw error}
 }
 function refresh(){for(const state of [...states])try{check(state,state.binding.conversationId)}catch{/* Revocation is observable through the retained signal. */}}
 const releaseInvalidated=options.targets.onInvalidated(()=>{for(const state of [...states])revoke(state)});
 const releaseDeleted=options.targets.onSessionDeleted(id=>{deleted.add(id);for(const state of [...states])if(state.binding.conversationId===id)revoke(state)});
 return Object.freeze({
  bind(event:Pick<IpcMainInvokeEvent,"sender"|"senderFrame">,conversationId:string):object {
   if(typeof conversationId!=="string"||!conversationId||conversationId.length>256||/[\u0000-\u001f\u007f]/.test(conversationId))return denied();
   refresh();const frame=event.senderFrame;if(!frame)return denied();
   const target=selected(event.sender,frame,conversationId);
   if(current)return current.token;
   const controller=new AbortController(),token=Object.freeze({});
   const binding=Object.freeze({conversationId,scopeKey,actorKey,webContentsId:target.webContentsId,signal:controller.signal});
   const state:GrantState={target:Object.freeze({...target}),sender:event.sender,frame,controller,binding};
   grants.set(token,state);states.add(state);current={token,state};return token;
  },
  require(token:object,conversationId:string):DesktopMemoryBinding {
   const state=token&&typeof token==="object"?grants.get(token):undefined;if(!state)return denied();
   check(state,conversationId);return state.binding;
  },
  refresh,
  dispose(){if(disposed)return;disposed=true;for(const state of [...states])revoke(state);releaseInvalidated();releaseDeleted()},
 });
}
export type MainDesktopSessionAuthority=NonNullable<ReturnType<typeof createMainDesktopSessionAuthority>>;
