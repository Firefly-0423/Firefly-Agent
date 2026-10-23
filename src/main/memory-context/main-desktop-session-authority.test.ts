import {EventEmitter} from "node:events";
import {describe,expect,it} from "vitest";
import {createActiveChatTargetRegistry} from "../plugin-host/active-chat-target";
import {createMainDesktopSessionAuthority} from "./main-desktop-session-authority";

function fixture(){
 const sender=Object.assign(new EventEmitter(),{id:7,mainFrame:{},isDestroyed:()=>false});
 let window:any={webContents:sender,isDestroyed:()=>false};
 const targets=createActiveChatTargetRegistry();const select=(sessionId="session-a")=>targets.setActive({sender:sender as any,sessionId,mode:"chat",rendererTargetId:"renderer-a"});select();
 const sessions=new Map([['session-a',{id:'session-a',mode:'chat',modelProfileId:'controlled'}],['session-b',{id:'session-b',mode:'chat',modelProfileId:'controlled'}]]);
 const authority=createMainDesktopSessionAuthority({enabled:true,scopeKey:"profile-a",actorKey:"local-user",getChatWindow:()=>window,targets,getSession:id=>sessions.get(id),isControlledSession:session=>session.mode==="chat"&&session.modelProfileId==="controlled"})!;
 const event={sender,senderFrame:sender.mainFrame};
 return {authority,sender,targets,event,sessions,select,setWindow:(value:any)=>{window=value}};
}
describe("Main desktop memory session grants",()=>{
 it("leaves default-off construction completely lazy",()=>{const options=new Proxy({},{get(_target,key){if(key==='enabled')return false;throw Error('DISABLED_READ_FORBIDDEN')}});expect(createMainDesktopSessionAuthority(options as any)).toBeNull()});
 it("binds one opaque grant to the actual Main chat host and its selected session",()=>{const f=fixture();const grant=f.authority.bind(f.event as any,'session-a');expect(Object.keys(grant)).toEqual([]);expect(Object.isFrozen(grant)).toBe(true);expect(f.authority.bind(f.event as any,'session-a')).toBe(grant);expect(f.authority.require(grant,'session-a')).toMatchObject({conversationId:'session-a',scopeKey:'profile-a',actorKey:'local-user',webContentsId:7});f.authority.dispose()});
 it.each(['foreign-host','subframe','missing-frame','cross-session','unselected'])('denies %s before issuing a grant',kind=>{const f=fixture();let event:any=f.event,id='session-a';if(kind==='foreign-host')event={sender:{...f.sender,id:7},senderFrame:f.sender.mainFrame};if(kind==='subframe')event={...f.event,senderFrame:{}};if(kind==='missing-frame')event={sender:f.sender};if(kind==='cross-session')id='session-b';if(kind==='unselected')f.targets.clearActive(f.sender as any);expect(()=>f.authority.bind(event,id)).toThrow('MEMORY_DESKTOP_SESSION_DENIED');f.authority.dispose()});
 it("rejects serialized/cross-authority tokens and cross-session use",()=>{const f=fixture(),other=fixture(),grant=f.authority.bind(f.event as any,'session-a');expect(()=>f.authority.require(JSON.parse(JSON.stringify(grant)),'session-a')).toThrow('MEMORY_DESKTOP_SESSION_DENIED');expect(()=>other.authority.require(grant,'session-a')).toThrow('MEMORY_DESKTOP_SESSION_DENIED');expect(()=>f.authority.require(grant,'session-b')).toThrow('MEMORY_DESKTOP_SESSION_DENIED');f.authority.dispose();other.authority.dispose()});
 it.each(['navigation','destroyed','delete','dispose','window-replaced','policy-drift'])('revokes and aborts a %s grant',kind=>{const f=fixture(),grant=f.authority.bind(f.event as any,'session-a'),binding=f.authority.require(grant,'session-a');if(kind==='navigation')f.sender.emit('did-start-navigation',{},'synthetic://next',false,true);if(kind==='destroyed')f.sender.emit('destroyed');if(kind==='delete')f.targets.notifySessionDeleted('session-a');if(kind==='dispose')f.authority.dispose();if(kind==='window-replaced')f.setWindow({webContents:{...f.sender},isDestroyed:()=>false});if(kind==='policy-drift')f.sessions.get('session-a')!.modelProfileId='ordinary';expect(()=>f.authority.require(grant,'session-a')).toThrow('MEMORY_DESKTOP_SESSION_DENIED');expect(binding.signal.aborted).toBe(true);f.authority.dispose()});
 it("switching away and back never revives an old grant",()=>{const f=fixture(),old=f.authority.bind(f.event as any,'session-a');f.select('session-b');f.authority.refresh();f.select('session-a');f.authority.refresh();expect(()=>f.authority.require(old,'session-a')).toThrow('MEMORY_DESKTOP_SESSION_DENIED');expect(f.authority.bind(f.event as any,'session-a')).not.toBe(old);f.authority.dispose()});
});
it.each(["work","code"] as const)("permits a Main-enabled %s target only when stored session and live target agree",mode=>{
 const sender=Object.assign(new EventEmitter(),{id:7,mainFrame:{},isDestroyed:()=>false}),targets=createActiveChatTargetRegistry();
 targets.setActive({sender:sender as any,sessionId:"session-a",mode,rendererTargetId:"renderer-a"});
 const session={id:"session-a",mode:mode as string,modelProfileId:"saved"};
 const input={enabled:true,scopeKey:"profile-a",actorKey:"local-user",getChatWindow:()=>({webContents:sender,isDestroyed:()=>false}) as any,targets,getSession:()=>session,isControlledSession:()=>true};
 const legacy=createMainDesktopSessionAuthority(input)!;
 expect(()=>legacy.bind({sender,senderFrame:sender.mainFrame} as any,"session-a")).toThrow("MEMORY_DESKTOP_SESSION_DENIED");legacy.dispose();
 const authority=createMainDesktopSessionAuthority({...input,allowedModes:["chat","work","code"]})!;
 const grant=authority.bind({sender,senderFrame:sender.mainFrame} as any,"session-a");expect(authority.require(grant,"session-a").signal.aborted).toBe(false);
 session.mode="chat";expect(()=>authority.require(grant,"session-a")).toThrow("MEMORY_DESKTOP_SESSION_DENIED");authority.dispose();
});
