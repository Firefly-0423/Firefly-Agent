import {EventEmitter} from "node:events";
import {expect,it} from "vitest";
import {contextFixture} from "../../../scripts/verify/memory-context/context-fixture";
import {createActiveChatTargetRegistry} from "../plugin-host/active-chat-target";
import {createMainDesktopSessionAuthority} from "../memory-context/main-desktop-session-authority";
import {createDesktopUserSourceProvider} from "./desktop-user-source-provider";

async function fixture(timeZone=()=>"UTC"){
 const f=await contextFixture(),sender=Object.assign(new EventEmitter(),{id:7,mainFrame:{},isDestroyed:()=>false}),targets=createActiveChatTargetRegistry();
 targets.setActive({sender:sender as any,sessionId:'session-a',mode:'chat',rendererTargetId:'r'});
 const makeAuthority=()=>createMainDesktopSessionAuthority({enabled:true,scopeKey:'scope-a',actorKey:'actor-a',getChatWindow:()=>({webContents:sender,isDestroyed:()=>false} as any),targets,getSession:id=>({id,mode:'chat'}),isControlledSession:()=>true})!;
 const authority=makeAuthority();
 const grant=authority.bind({sender,senderFrame:sender.mainFrame} as any,'session-a'),users=new Map<string,{role:string;text:string}>();
 const make=(owner=authority)=>createDesktopUserSourceProvider({authority:owner,providerId:'synthetic',scopeKey:'scope-a',readUser:identity=>users.get(identity.messageId)??null,clock:()=>1700000000000,timeZone});
 const source=make();source.attachSession(grant,'session-a');
 const id={providerId:'synthetic',sessionId:'session-a',messageId:'u1'};
 const capture=(service=source)=>f.registry.capture(f.access,service.token,id);
 const commit=()=>{const ticket=source.prepareUserCommit(grant,'session-a','u1');users.set('u1',{role:'user',text:'I prefer bash'});source.finishUserCommit(ticket)};
 return {...f,users,authority,grant,source,make,makeAuthority,event:{sender,senderFrame:sender.mainFrame},id,capture,commit};
}
it('denies arbitrary historical user/model text without a Main direct-commit receipt',async()=>{const f=await fixture();f.users.set('u1',{role:'user',text:'I prefer bash'});expect(()=>f.source.prepareUserCommit(f.grant,'session-a','u1')).toThrow('MEMORY_USER_SOURCE_DENIED');await expect(f.capture()).rejects.toThrow('MEMORY_USER_SOURCE_DENIED');f.authority.dispose()});
it('publishes only the committed Main user event, with provider time and original binding',async()=>{const f=await fixture();f.commit();const ref=await f.capture();expect(ref.binding).toMatchObject({providerId:'synthetic',sessionId:'session-a',messageId:'u1',contentRevision:1});expect(f.registry.resolveVerifiedSource(ref)).toMatchObject({kind:'user',sourceTrust:'direct-user-event'});expect(await f.registry.readEvidence(f.access,f.source.token,ref)).toBe('I prefer bash');f.authority.dispose()});
it('does not let a model/assistant or uncommitted ticket mint a user source',async()=>{const f=await fixture();expect(()=>f.source.finishUserCommit({})).toThrow('MEMORY_USER_SOURCE_DENIED');const ticket=f.source.prepareUserCommit(f.grant,'session-a','u1');f.users.set('u1',{role:'assistant',text:'I prefer bash'});expect(()=>f.source.finishUserCommit(ticket)).toThrow('MEMORY_USER_SOURCE_DENIED');await expect(f.capture()).rejects.toThrow('MEMORY_USER_SOURCE_DENIED');f.authority.dispose()});
it('revocation between admission and commit prevents source publication',async()=>{const f=await fixture(),ticket=f.source.prepareUserCommit(f.grant,'session-a','u1');f.users.set('u1',{role:'user',text:'I prefer bash'});f.authority.dispose();expect(()=>f.source.finishUserCommit(ticket)).toThrow('MEMORY_DESKTOP_SESSION_DENIED');await expect(f.capture()).rejects.toThrow('MEMORY_USER_SOURCE_DENIED')});
it('source capture after repository reopen and fresh Main grants inherits only exact encrypted ledger provenance',async()=>{const f=await fixture();f.commit();const original=await f.capture();f.authority.dispose();f.reopen();const owner=f.makeAuthority(),grant=owner.bind(f.event as any,'session-a'),next=f.make(owner);next.attachSession(grant,'session-a');const {createMainSourceRegistry}=await import('./source-registry'),registry=createMainSourceRegistry(f.transport,{coordinate:f.actorAuthority.coordinate}),access=registry.authority.access('scope-a');const fresh=await registry.capture(access,next.token,f.id);expect(fresh).toEqual(original);expect(await registry.readEvidence(access,next.token,fresh)).toBe('I prefer bash');owner.dispose()});
it.each(['edit','delete','role'])('invalidates %s rather than promoting altered historical text to a direct event',async kind=>{const f=await fixture();f.commit();const ref=await f.capture();const next=f.make();next.attachSession(f.grant,'session-a');if(kind==='edit')f.users.set('u1',{role:'user',text:'I prefer powershell'});if(kind==='delete')f.users.delete('u1');if(kind==='role')f.users.set('u1',{role:'assistant',text:'I prefer bash'});await expect(f.registry.readEvidence(f.access,next.token,ref)).rejects.toThrow('MEMORY_SOURCE_DELETED');f.authority.dispose()});
it('isolates its private provider and rejects cross-session receipt use',async()=>{const f=await fixture();expect(()=>f.source.prepareUserCommit(f.grant,'session-b','u1')).toThrow('MEMORY_DESKTOP_SESSION_DENIED');const next=f.make();const ticket=f.source.prepareUserCommit(f.grant,'session-a','u1');f.users.set('u1',{role:'user',text:'I prefer bash'});expect(()=>next.finishUserCommit(ticket)).toThrow('MEMORY_USER_SOURCE_DENIED');f.source.finishUserCommit(ticket);expect(()=>f.source.finishUserCommit(ticket)).toThrow('MEMORY_USER_SOURCE_DENIED');f.authority.dispose()});

it('holds direct source bytes stable until the source lease finishes',async()=>{
 const f=await fixture();f.commit();const {requireMainSourceProvider}=await import('./main-source-provider');const provider=requireMainSourceProvider(f.source.token,'scope-a',f.id);
 let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);
 const reading=provider.withLease(f.id,async read=>{const first=await read();entered();await held;expect(await read()).toEqual(first)});
 await ready;let changed=false;const mutation=f.source.mutate(()=>{changed=true;f.users.set('u1',{role:'user',text:'changed'})});await Promise.resolve();expect(changed).toBe(false);release();await reading;await mutation;expect(changed).toBe(true);f.authority.dispose();
});

it('admits each fresh message identity once even before metadata is committed',async()=>{const f=await fixture();f.source.prepareUserCommit(f.grant,'session-a','u1');expect(()=>f.source.prepareUserCommit(f.grant,'session-a','u1')).toThrow('MEMORY_USER_SOURCE_DENIED');f.authority.dispose()});

it('Main-owned historical access restores only ledger provenance, never historical text as a new fact',async()=>{
 const f=await fixture();f.commit();const ref=await f.capture();const restored=createDesktopUserSourceProvider({authority:f.authority,providerId:'synthetic',scopeKey:'scope-a',readUser:id=>f.users.get(id.messageId)??null,clock:()=>1700000000001,isOwnedSession:id=>id==='session-a'});
 expect(await f.registry.readEvidence(f.access,restored.token,ref)).toBe('I prefer bash');f.authority.dispose();
});
it('an explicit authorized canonical edit admits a new revision; raw history edits do not',async()=>{
 const f=await fixture();f.commit();const old=await f.capture();f.users.set('u1',{role:'user',text:'I prefer PowerShell'});
 const edited=createDesktopUserSourceProvider({authority:f.authority,providerId:'synthetic',scopeKey:'scope-a',readUser:id=>f.users.get(id.messageId)??null,clock:()=>1700000000001,readCommittedEdit:async()=>({revision:2,text:'I prefer PowerShell'})});
 edited.attachSession(f.grant,'session-a');await expect(f.registry.readEvidence(f.access,edited.token,old)).rejects.toThrow('MEMORY_SOURCE_DELETED');
 await expect(edited.commitUserEdit({},'session-a','u1')).rejects.toThrow('MEMORY_DESKTOP_SESSION_DENIED');
 await edited.commitUserEdit(f.grant,'session-a','u1');const fresh=await f.registry.capture(f.access,edited.token,f.id);
 expect(fresh.binding.contentRevision).toBe(2);expect(fresh.binding.generation).not.toBe(old.binding.generation);expect(await f.registry.readEvidence(f.access,edited.token,fresh)).toBe('I prefer PowerShell');f.authority.dispose();
});

it('releases only a genuine still-uncommitted ticket so a definite failed append can retry',async()=>{
 const f=await fixture(),first=f.source.prepareUserCommit(f.grant,'session-a','u1');
 expect(()=>f.source.cancelUserCommit({...first})).toThrow('MEMORY_USER_SOURCE_DENIED');
 f.source.cancelUserCommit(first);
 expect(()=>f.source.finishUserCommit(first)).toThrow('MEMORY_USER_SOURCE_DENIED');
 const retry=f.source.prepareUserCommit(f.grant,'session-a','u1');
 f.users.set('u1',{role:'user',text:'I prefer bash'});f.source.finishUserCommit(retry);
 expect(await f.capture()).toMatchObject({binding:{messageId:'u1',contentRevision:1}});
 f.authority.dispose();
});
it('does not cancel a written, finished, foreign, or already consumed user ticket',async()=>{
 const f=await fixture(),ticket=f.source.prepareUserCommit(f.grant,'session-a','u1'),foreign=f.make();
 expect(()=>foreign.cancelUserCommit(ticket)).toThrow('MEMORY_USER_SOURCE_DENIED');
 f.users.set('u1',{role:'user',text:'I prefer bash'});
 expect(()=>f.source.cancelUserCommit(ticket)).toThrow('MEMORY_USER_SOURCE_DENIED');
 f.source.finishUserCommit(ticket);f.users.delete('u1');
 expect(()=>f.source.cancelUserCommit(ticket)).toThrow('MEMORY_USER_SOURCE_DENIED');
 expect(()=>f.source.prepareUserCommit(f.grant,'session-a','u1')).toThrow('MEMORY_USER_SOURCE_DENIED');
 f.authority.dispose();
});

it('retains the commit timezone after host change and encrypted-ledger restore',async()=>{
 let zone='America/New_York';const f=await fixture(()=>zone);f.commit();zone='Asia/Shanghai';const ref=await f.capture();
 const observation=()=>f.transport.sourceCommand({kind:'validate',scopeKey:'scope-a',body:{sourceRef:ref}});
 expect(await observation()).toMatchObject({timeZone:'America/New_York',occurredAt:1700000000000});
 f.reopen();const restored=f.make();restored.attachSession(f.grant,'session-a');expect(await f.capture(restored)).toEqual(ref);
 expect(await observation()).toMatchObject({timeZone:'America/New_York'});f.authority.dispose();
});
