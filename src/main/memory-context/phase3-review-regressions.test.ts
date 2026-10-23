import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {expect,it,afterEach} from 'vitest';
import {createSmhFixture} from '../memory-context/smh-fixture.test-support';
import {parseFactTimeQuery} from '../memory-policy/fact-temporal';
import {validateNaturalResponse} from '../memory-policy/natural-protocol';
import {createMainHistoryProvider} from '../memory-history/main-history';
import {historyOriginEvent} from '../memory-history/history-origins';
const now=Date.parse('2026-03-09T12:00:00Z'), source={occurredAt:now,timeZone:'UTC'};
const owned:ReturnType<typeof createSmhFixture>[]=[];
afterEach(()=>{for(const f of owned.splice(0)){f.close();fs.rmSync(f.root,{recursive:true,force:true})}});
function fixture(){const f=createSmhFixture(fs.mkdtempSync(path.join(os.tmpdir(),'phase3-review-')),{clock:()=>now,includeFactSupportMetadata:true});owned.push(f);return f}
const raw=(quote:string)=>JSON.stringify({facts:[{subject:'user',attribute:'language',value:'English',polarity:'positive',status:'asserted',quote,reason:'direct statement'}]});
it('ordinary 4001-character user message still assembles',async()=>{
 const f=fixture(),q=await f.source('a'.repeat(4001),source);
 await expect(f.context.assemble(f.actor,{sessionId:'session-a',sourceRefs:[q.ref],currentUserSourceRef:q.ref,factRefs:[]})).resolves.toBeDefined();
});
it('single-quoted historical question grants no temporal authority',()=>{
 expect(parseFactTimeQuery("'What language did I prefer yesterday?'",source)).toBeUndefined();
});
it('original full evidence quote must retain the 200-character limit',()=>{
 const text='Yesterday,'+' '.repeat(190)+'I prefer English';
 expect(validateNaturalResponse(raw(text),text,'message',source)).toEqual([]);
});
it.each(['before-query','after-query','after-permit'])('corrected temporal assertion cannot return via H: %s',async(timing)=>{
 const f=fixture(),text='2026-01-01, I prefer English',s=await f.source(text,source);
 const model:any={profile:{id:'fake',revision:1},assertCurrent(){},prepare(){return {ok:true,async send(){return {ok:true,text:raw(text)}}}}};
 const result=await f.policy.extractNatural(f.actor,s.ref,model),c=result.items[0],proof=await f.source('Confirm this exact candidate',source);
 const active=await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:'confirm',nonce:randomUUID(),candidateId:c.candidateId,revision:c.candidateRevision,sourceRef:proof.ref}));
 const doc={id:'native-'+'a'.repeat(64),incarnation:'native-'+'b'.repeat(64),revision:1,origin:'canonical' as const,classification:'raw-history' as const,sourceDeps:[],vector:null,messages:[{id:s.id.messageId,role:'user' as const,text,occurredAt:now,timeZone:'UTC'}],provenance:[{originalId:s.id.messageId,seq:1,turnId:s.id.messageId,revision:1,incarnation:'native-'+'b'.repeat(64),digest:'c'.repeat(64),span:{start:0,end:text.length},originalRole:'user' as const,occurredAt:now,timeZone:'UTC',active:true,format:'transcript-v1' as const,providerId:'synthetic',sessionId:'session-a'}]};
 const entry={id:s.id.messageId,seq:1,turnId:s.id.messageId,revision:1,kind:'user' as const,at:now,payload:{text}};
 doc.provenance[0].digest=historyOriginEvent(entry).digest;
 await f.context.recordHistoryUser(f.actor,s.ref,entry);
 const provider=createMainHistoryProvider(f.actorAuthority,f.actor,{withLease:async(_locator,run)=>run(async()=>structuredClone(doc))});
 await f.history.captureTranscript(f.actor,provider,'old-statement');
 const edit=await f.source('Chinese',source);
 async function awaitEvent(){return f.policy.event(f.actor,{kind:'correct',nonce:randomUUID(),factId:active.factId,revision:1,sourceRef:edit.ref})}
 const applyCorrection=async()=>f.policy.act(f.actor,await awaitEvent());
 if(timing==='before-query')await applyCorrection();
 const h=await f.history.query(f.actor,{query:'English'});
 const q=await f.source('What language did I prefer on 2026-01-01?',source);
 if(timing==='after-query'){await applyCorrection();await expect(f.context.assemble(f.actor,{sessionId:'session-a',sourceRefs:[q.ref],currentUserSourceRef:q.ref,factRefs:[],historyTokens:[h.evidence]})).rejects.toThrow();return}
 const snap=await f.context.assemble(f.actor,{sessionId:'session-a',sourceRefs:[q.ref],currentUserSourceRef:q.ref,factRefs:[],historyTokens:[h.evidence]});
 const permit=await f.context.validateForDispatch(f.actor,snap);let wire='';
 if(timing==='after-permit'){await applyCorrection();await expect(f.context.dispatch(f.actor,permit,()=>{throw Error('MUST_NOT_SEND')})).rejects.toThrow();return}
 await f.context.dispatch(f.actor,permit,request=>{wire=JSON.stringify(request.body);return 'fake'});
 expect(wire).not.toContain(text);
});

it.each(['correct','source-edit'])('unlinked assistant echo cannot revive a fact after %s',async mode=>{
 const f=fixture(),text='2026-01-01, I prefer English',s=await f.source(text,source);
 const model:any={profile:{id:'fake',revision:1},assertCurrent(){},prepare(){return {ok:true,async send(){return {ok:true,text:raw(text)}}}}};
 const result=await f.policy.extractNatural(f.actor,s.ref,model),c=result.items[0],proof=await f.source('Confirm this exact candidate',source);
 const active=await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:'confirm',nonce:randomUUID(),candidateId:c.candidateId,revision:c.candidateRevision,sourceRef:proof.ref}));
 const actor=f.actorAuthority.bindActor(f.access,f.adapter,{...f.identity,sessionId:'session-b'}),echo='You preferred English on 2026-01-01.';
 const messages=[{id:'unlinked-question',role:'user' as const,text:'What language did I prefer?',occurredAt:now,timeZone:'UTC'},{id:'unlinked-answer',role:'assistant' as const,text:echo,occurredAt:now,timeZone:'UTC'}];
 const doc={id:'native-'+'d'.repeat(64),incarnation:'native-'+'e'.repeat(64),revision:2,origin:'canonical' as const,classification:'raw-history' as const,sourceDeps:[],vector:null,messages,provenance:messages.map((m,i)=>({originalId:m.id,seq:i+1,turnId:'unlinked-question',revision:1,incarnation:'native-'+'e'.repeat(64),digest:'f'.repeat(64),span:{start:0,end:m.text.length},originalRole:m.role,occurredAt:now,timeZone:'UTC',active:true,format:'transcript-v1' as const,providerId:'synthetic',sessionId:'session-b'}))};
 const provider=createMainHistoryProvider(f.actorAuthority,actor,{withLease:async(_locator,run)=>run(async()=>structuredClone(doc))});
 // An unproved assistant is denied even before a correction: parser provenance
 // cannot manufacture a dependency closure or seed an old cache.
 await expect(f.history.captureTranscript(actor,provider,'echo')).rejects.toThrow('MEMORY_HISTORY_STALE');
 if(mode==='correct'){
  const edit=await f.source('Chinese',source);await f.policy.act(f.actor,await f.policy.event(f.actor,{kind:'correct',nonce:randomUUID(),factId:active.factId,revision:1,sourceRef:edit.ref}));
 }else{
  f.write(s.id,{text:'Removed original assertion',role:'user',trust:'direct-user-event',...source});await f.registry.capture(f.access,f.adapter,s.id);
 }
 const h=await f.history.query(actor,{query:'English'}),q=await f.source('What language did I prefer on 2026-01-01?',{...source,sessionId:'session-b'});
 const snap=await f.context.assemble(actor,{sessionId:'session-b',sourceRefs:[q.ref],currentUserSourceRef:q.ref,factRefs:[],historyTokens:[h.evidence]});
 const permit=await f.context.validateForDispatch(actor,snap);let wire='';await f.context.dispatch(actor,permit,r=>{wire=JSON.stringify(r.body);return 'fake'});
 expect(wire).not.toContain(echo);
});

it('parenthesized quoted historical question has no authority',()=>{expect(parseFactTimeQuery("Analyze ('What language did I prefer yesterday?').",source)).toBeUndefined()});
