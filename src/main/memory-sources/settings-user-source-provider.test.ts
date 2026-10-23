import { EventEmitter } from 'node:events';
import path from 'node:path';
import { expect, it } from 'vitest';
import { contextFixture } from '../../../scripts/verify/memory-context/context-fixture';
import { ConversationTranscriptStore } from '../orchestrator/conversation-transcript-store';

async function fixture(){
 const {createSettingsUserSourceProvider}=await import('./settings-user-source-provider');
 const f=await contextFixture(),store=new ConversationTranscriptStore(path.join(f.root,'settings-transcript'));
 const sender=Object.assign(new EventEmitter(),{id:99,mainFrame:{},isDestroyed:()=>false});
 const window={webContents:sender,isDestroyed:()=>false};let current:typeof window|null=window;
 const options={scopeKey:'scope-a',providerId:'synthetic',sessionId:'settings-events',store,clock:()=>1700000000000,getSettingsWindow:()=>current as any};
 const source=createSettingsUserSourceProvider(options),event={sender,senderFrame:sender.mainFrame} as any;
 const capture=(messageId:string,service=source)=>f.registry.capture(f.access,service.token,{providerId:'synthetic',sessionId:'settings-events',messageId});
 return {...f,store,source,event,options,capture,detach(){current=null}};
}
it('authorizes only the actual settings main frame before canonical writes',async()=>{
 const f=await fixture();
 for(const event of [{...f.event,sender:{}},{...f.event,senderFrame:{}},{...f.event,senderFrame:null}])expect(()=>f.source.authorize(event)).toThrow('MEMORY_SETTINGS_FORBIDDEN');
 await expect(f.source.commitUserEvent({}, {messageId:'confirm-1',text:'I confirm this preference.'})).rejects.toThrow('MEMORY_SETTINGS_FORBIDDEN');
 expect((await f.store.read('settings-events')).entries).toEqual([]);
});
it('publishes an independent Main user event with canonical bytes and a direct receipt',async()=>{
 const f=await fixture(),grant=f.source.authorize(f.event);
 await f.source.commitUserEvent(grant,{messageId:'confirm-1',text:'I confirm this preference.'});
 const ref=await f.capture('confirm-1');expect(ref.binding).toMatchObject({sessionId:'settings-events',messageId:'confirm-1',contentRevision:1});
 expect(f.registry.resolveVerifiedSource(ref)).toMatchObject({kind:'user',sourceTrust:'direct-user-event'});
 expect(await f.registry.readEvidence(f.access,f.source.token,ref)).toBe('I confirm this preference.');
 expect((await f.store.read('settings-events')).entries).toHaveLength(1);
 await expect(f.source.commitUserEvent(grant,{messageId:'confirm-1',text:'duplicate'})).rejects.toThrow('MEMORY_USER_SOURCE_DENIED');
});
it('cannot turn arbitrary persisted role=user text into a newly confirmed source',async()=>{
 const f=await fixture();await f.store.append('settings-events',{id:'historical-user',kind:'user',turnId:'historical-user',revision:1,payload:{text:'I prefer bash'}});
 await expect(f.capture('historical-user')).rejects.toThrow('MEMORY_USER_SOURCE_DENIED');
 await expect(f.source.commitUserEvent(f.source.authorize(f.event),{messageId:'historical-user',text:'I prefer bash'})).rejects.toThrow('MEMORY_USER_SOURCE_DENIED');
});
it('restores only existing encrypted-head provenance after a new source owner starts',async()=>{
 const f=await fixture();await f.source.commitUserEvent(f.source.authorize(f.event),{messageId:'confirm-1',text:'I prefer bash'});
 const old=await f.capture('confirm-1');
 const {createSettingsUserSourceProvider}=await import('./settings-user-source-provider'),restored=createSettingsUserSourceProvider(f.options);
 expect(await f.capture('confirm-1',restored)).toEqual(old);
 expect(await f.registry.readEvidence(f.access,restored.token,old)).toBe('I prefer bash');
});
it('window loss revokes action grants while preserving committed source evidence',async()=>{
 const f=await fixture(),grant=f.source.authorize(f.event);await f.source.commitUserEvent(grant,{messageId:'one',text:'I prefer bash'});const ref=await f.capture('one');
 f.detach();await expect(f.source.commitUserEvent(grant,{messageId:'two',text:'I prefer fish'})).rejects.toThrow('MEMORY_SETTINGS_FORBIDDEN');
 expect(await f.registry.readEvidence(f.access,f.source.token,ref)).toBe('I prefer bash');
});
it('a canonical edit invalidates the old receipt instead of authorizing new text',async()=>{
 const f=await fixture();await f.source.commitUserEvent(f.source.authorize(f.event),{messageId:'one',text:'I prefer bash'});const ref=await f.capture('one');
 await f.store.append('settings-events',{id:'edited',kind:'turn_rewind',turnId:'one',revision:2,payload:{anchorUserTurnId:'one',disposition:'replace_user',reason:'edit',replacementUser:{text:'I prefer fish'}}});
 await expect(f.registry.readEvidence(f.access,f.source.token,ref)).rejects.toThrow('MEMORY_SOURCE_DELETED');
});

it('rechecks the settings grant after a queued mutation observer and before canonical persistence',async()=>{
 const f=await fixture(),grant=f.source.authorize(f.event);let arrive!:()=>void,release!:()=>void;
 const arrived=new Promise<void>(resolve=>{arrive=resolve}),held=new Promise<void>(resolve=>{release=resolve});
 const stop=f.store.observeMutations('settings-events',async()=>{arrive();await held});
 const pending=f.source.commitUserEvent(grant,{messageId:'late',text:'I prefer bash'}),rejected=expect(pending).rejects.toThrow('MEMORY_SETTINGS_FORBIDDEN');
 await arrived;f.detach();release();await rejected;stop();
 expect((await f.store.read('settings-events')).entries).toEqual([]);await expect(f.capture('late')).rejects.toThrow('MEMORY_USER_SOURCE_DENIED');
});
it('close waits for a leased operation and rejects its late result',async()=>{
 const f=await fixture();await f.source.commitUserEvent(f.source.authorize(f.event),{messageId:'one',text:'I prefer bash'});
 const {requireMainSourceProvider}=await import('./main-source-provider');const provider=requireMainSourceProvider(f.source.token,'scope-a',{providerId:'synthetic',sessionId:'settings-events',messageId:'one'});
 let arrive!:()=>void,release!:()=>void;const arrived=new Promise<void>(resolve=>{arrive=resolve}),held=new Promise<void>(resolve=>{release=resolve});
 const pending=provider.withLease({providerId:'synthetic',sessionId:'settings-events',messageId:'one'},async read=>{await read();arrive();await held;return 'late-result'});
 await arrived;let acknowledged=false;const closing=f.source.close().then(()=>{acknowledged=true});await Promise.resolve();expect(acknowledged).toBe(false);
 const rejected=expect(pending).rejects.toThrow('MEMORY_USER_SOURCE_DENIED');release();await rejected;await closing;
});

it('the owner lifetime revokes an in-flight settings source at the final canonical write guard',async()=>{
 const f=await fixture(),controller=new AbortController(),{createSettingsUserSourceProvider}=await import('./settings-user-source-provider');
 const source=createSettingsUserSourceProvider({...f.options,signal:controller.signal}),grant=source.authorize(f.event);
 let arrive!:()=>void,release!:()=>void;const arrived=new Promise<void>(resolve=>{arrive=resolve}),held=new Promise<void>(resolve=>{release=resolve});
 const stop=f.store.observeMutations('settings-events',async()=>{arrive();await held});
 const pending=source.commitUserEvent(grant,{messageId:'lifetime',text:'I prefer bash'}),outcome=pending.then(value=>value,error=>error);
 await arrived;controller.abort();release();expect(await outcome).toBeInstanceOf(Error);stop();
 expect((await f.store.read('settings-events')).entries).toEqual([]);await source.close();
});
