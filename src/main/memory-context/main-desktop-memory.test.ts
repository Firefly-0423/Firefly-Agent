import {beforeEach,it,expect,vi} from "vitest";
import {EventEmitter} from "node:events";
import {createActiveChatTargetRegistry} from "../plugin-host/active-chat-target";
import {createMainDesktopMemory} from "./main-desktop-memory";
import {contextFixture} from "../../../scripts/verify/memory-context/context-fixture";
import {ConversationTranscriptStore} from "../orchestrator/conversation-transcript-store";
import path from "node:path";
import {mkdirSync} from "node:fs";
let preparedFixture:Awaited<ReturnType<typeof createFixture>>;
beforeEach(async()=>{preparedFixture=await createFixture()});
async function fixture(){return preparedFixture}
async function createFixture(){
 const f=await contextFixture(),sender=Object.assign(new EventEmitter(),{id:7,mainFrame:{},isDestroyed:()=>false}),targets=createActiveChatTargetRegistry();targets.setActive({sender:sender as any,sessionId:"session-a",mode:"chat",rendererTargetId:"r"});
 const sessions=new Map<string,any>([["session-a",{id:"session-a",mode:"chat",messages:[]}],["session-b",{id:"session-b",mode:"chat",messages:[]}]]);let opened=0,closed=0;
 const options={enabled:true,getChatWindow:()=>({webContents:sender,isDestroyed:()=>false} as any),targets,getSession:(id:string)=>sessions.get(id),listSessionIds:()=>[...sessions.keys()],isControlledSession:()=>true,store:new ConversationTranscriptStore(path.join(f.root,"desktop-transcripts")),clock:()=>1700000000010,openBackend:async()=>{opened++;return {transport:f.transport,close:async()=>{closed++},binding:{} as any,request:()=>({} as any),endpointFactory:(async()=>{throw Error("UNUSED_NATIVE")}) as any}}};
 const memory=createMainDesktopMemory(options)!;return {...f,sender,targets,sessions,options,memory,event:{sender,senderFrame:sender.mainFrame} as any,get opened(){return opened},get closed(){return closed}};
}
it("default off opens no Worker, models, sender or authority",async()=>{let opened=0;expect(createMainDesktopMemory({enabled:false,openBackend:()=>{opened++;throw Error("unexpected")}} as any)).toBeNull();expect(opened).toBe(0)});
it("sender/frame authorization precedes resource opening and metadata writes",async()=>{const f=await fixture();let writes=0;await expect(f.memory.appendUser({...f.event,senderFrame:{}},"session-a",{id:"u",role:"user",content:"I prefer PowerShell"},()=>{writes++;return null})).rejects.toThrow("MEMORY_DESKTOP_SESSION_DENIED");expect(writes).toBe(0);expect(f.opened).toBe(0);await f.memory.close()});
it("fresh Main append publishes once, arbitrary saved history and inactive sessions cannot opt into runs",async()=>{const f=await fixture(),message={id:"u",role:"user",content:"I prefer PowerShell"} as any;await f.memory.appendUser(f.event,"session-a",message,()=>{f.sessions.get("session-a").messages.push(message);return true});expect(f.opened).toBe(1);await expect(f.memory.appendUser(f.event,"session-a",message,()=>true)).rejects.toThrow("MEMORY_USER_SOURCE_DENIED");expect(f.memory.sContext.isControlledSession("session-a")).toBe(false);const grant=f.memory.authorizeRun(f.event,"session-a");expect(f.memory.sContext.isControlledSession("session-a")).toBe(true);expect(()=>f.memory.authorizeRun(f.event,"session-b")).toThrow("MEMORY_DESKTOP_SESSION_DENIED");grant!.release();expect(f.memory.sContext.isControlledSession("session-a")).toBe(false);await f.memory.close();await f.memory.close();expect(f.closed).toBe(1)});
it("navigation/target loss aborts a private run grant; serialized fields never revive it",async()=>{const f=await fixture(),grant=f.memory.authorizeRun(f.event,"session-a")!;f.targets.clearActive(f.sender as any);f.memory.refresh();expect(grant.signal.aborted).toBe(true);expect(f.memory.sContext.isControlledSession("session-a")).toBe(false);await f.memory.close();expect(f.opened).toBe(0)});

it("a previously controlled session cannot fall back when Main profile selection changes",async()=>{
 const f=await fixture();f.memory.authorizeRun(f.event,'session-a')!.release();f.options.isControlledSession=()=>false;
 expect(f.memory.ownsSession('session-a')).toBe(true);expect(()=>f.memory.authorizeRun(f.event,'session-a')).toThrow('MEMORY_DESKTOP_SESSION_DENIED');await f.memory.close();
});

it("shutdown revokes admission and waits for an in-flight controlled port before closing its Worker",async()=>{
 const f=await fixture(),{initializeStorageContext}=await import('../storage-context'),{resolveRuntimeProfile}=await import('../runtime-profile');mkdirSync(path.join(f.root,'lifecycle-isolation'));initializeStorageContext(resolveRuntimeProfile({argv:['--firefly-profile=test','--firefly-isolation-root='+path.join(f.root,'lifecycle-isolation')],env:{},isPackaged:false,productionAppData:path.join(f.root,'unopened')}));
 let release!:()=>void,signal:AbortSignal|undefined;const pending=new Promise<any>(resolve=>{release=()=>resolve({status:'sent',requestDigest:'synthetic',result:{}})}),module=await import('./main-s-runtime-port'),spy=vi.spyOn(module,'createMainSRuntimePort').mockReturnValue({run:input=>{signal=input.signal;return pending}});
 let run:Promise<any>|undefined,closing:Promise<void>|undefined;
 try{f.memory.authorizeRun(f.event,'session-a');const port=await f.memory.sContext.createPort({conversationId:'session-a'});run=port.run({request:{} as any});closing=f.memory.close();await new Promise<void>(resolve=>setImmediate(resolve));expect(signal?.aborted).toBe(true);expect(f.closed).toBe(0);release();await run;await closing;expect(f.closed).toBe(1)}finally{release();await run;await closing;spy.mockRestore()}
});
