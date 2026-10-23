import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {afterEach,describe,expect,it} from 'vitest';
import {openMemoryRepository} from '../memory-core/repository';
import type {ShadowModel,ShadowSendResult} from './shadow-model-call';
import {createShadowService,type ShadowTask} from './shadow-service';

const SCOPE='scope-a',ACTOR='actor-a';
const roots:string[]=[],repositories:ReturnType<typeof openMemoryRepository>[]=[];
afterEach(()=>{for(const r of repositories.splice(0))r.close();for(const p of roots.splice(0))fs.rmSync(p,{recursive:true,force:true})});

const goodAnswer=(quote='我平时用 VS Code')=>JSON.stringify({facts:[{subject:'user',attribute:'tool',value:'VS Code',polarity:'positive',status:'asserted',quote,reason:'用户直接说明'}]});

function fixture(maxQueue?:number){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'shadow-service-'));roots.push(root);
 const repo=openMemoryRepository({databasePath:path.join(root,'memory.sqlite'),key:randomBytes(32)});repositories.push(repo);
 let n=0,message=0;
 const source=(kind:string,body:unknown)=>(repo as any).sourceCommand({kind,scopeKey:SCOPE,commandId:'source-'+ ++n,body});
 const transport={shadowCommand:async (c:unknown)=>(repo as any).shadowCommand(c)};
 const direct=(kind:string,body:Record<string,unknown>={})=>(repo as any).shadowCommand({kind,scopeKey:SCOPE,...(['status','export'].includes(kind)?{}:{commandId:'direct-'+ ++n}),body:{actorKey:ACTOR,...body}});
 const errors:unknown[]=[];
 const service=createShadowService({transport,scopeKey:SCOPE,actorKey:ACTOR,...(maxQueue?{maxQueue}:{}),onError:e=>errors.push(e)});
 function publish(){
  const identity={providerId:'desktop',sessionId:'session-a',messageId:'message-'+ ++message},r=source('reserve',{identity,expectedRef:null});
  return source('finish',{sourceId:r.sourceId,operationId:r.operationId,observation:{...identity,contentRevision:1,generation:'generation-a',state:'live',role:'user',trust:'direct-user-event',fingerprint:'a'.repeat(64)}});
 }
 function edit(ref:any){
  const identity={providerId:ref.binding.providerId,sessionId:ref.binding.sessionId,messageId:ref.binding.messageId},r=source('reserve',{identity,expectedRef:ref});
  return source('finish',{sourceId:r.sourceId,operationId:r.operationId,observation:{...identity,contentRevision:2,generation:'generation-a',state:'live',role:'user',trust:'direct-user-event',fingerprint:'b'.repeat(64)}});
 }
 const enable=(dailyCap=50)=>direct('configure',{enabled:true,dailyCap,expectedRevision:direct('status').revision});
 return {service,direct,publish,edit,enable,errors};
}

interface FakeOptions {answer?:ShadowSendResult|(()=>Promise<ShadowSendResult>);noLimit?:boolean;current?:()=>void}
function fakeModel(options:FakeOptions={}){
 const state={prepared:0,sent:0,signal:undefined as AbortSignal|undefined};
 const model:ShadowModel={
  profile:{id:'profile-a',revision:1},
  assertCurrent:options.current??(()=>undefined),
  prepare(){
   state.prepared++;
   if(options.noLimit)return {ok:false,reason:'no-output-limit'};
   return {ok:true,async send(signal){
    state.sent++;state.signal=signal;
    if(typeof options.answer==='function')return options.answer();
    return options.answer??{ok:true,text:goodAnswer()};
   }};
  },
 };
 return {model,state};
}
const taskFor=(ref:any,model:ShadowModel,text='我平时用 VS Code',sessionId='session-a'):ShadowTask=>({sessionId,sourceRef:ref,model,turn:{user:{id:ref.binding.messageId,text}}});
/** 一个可手动放行的在途请求，遇到取消立即返回 cancelled。 */
function gate(text=goodAnswer()){
 let release!:()=>void;let started!:()=>void;const startedPromise=new Promise<void>(r=>{started=r});
 const wait=new Promise<void>(r=>{release=r});
 const send=(signal:AbortSignal):Promise<ShadowSendResult>=>{started();return new Promise(resolve=>{
  signal.addEventListener('abort',()=>resolve({ok:false,kind:'cancelled'}),{once:true});
  void wait.then(()=>resolve({ok:true,text}));
 })};
 return {release,started:startedPromise,send};
}
function gatedModel(g:ReturnType<typeof gate>):ShadowModel {
 return {profile:{id:'profile-a',revision:1},assertCurrent:()=>undefined,prepare:()=>({ok:true,send:g.send})};
}

describe('shadow service',()=>{
 it('does nothing at all while the switch is off: no request, no database write',async()=>{
  const f=fixture(),ref=f.publish(),m=fakeModel();
  f.service.submit(taskFor(ref,m.model));await f.service.idle();
  expect(m.state.prepared).toBe(0);expect(m.state.sent).toBe(0);
  expect(f.direct('status')).toMatchObject({used:0,counters:{}});
 });

 it('extracts after enabling and stores the validated candidate',async()=>{
  const f=fixture(),ref=f.publish(),m=fakeModel();f.enable();
  f.service.submit(taskFor(ref,m.model));await f.service.idle();
  expect(m.state.sent).toBe(1);
  expect(f.direct('export')).toMatchObject([{candidate:{attribute:'tool',value:'VS Code'},promptVersion:'m-shadow-prompt-v1',profile:{id:'profile-a',revision:1}}]);
  expect(f.direct('status')).toMatchObject({used:1,counters:{sent:1,candidates:1}});
  expect(f.errors).toEqual([]);
 });

 it('registers a source revision only once even if submitted repeatedly',async()=>{
  const f=fixture(),ref=f.publish(),m=fakeModel();f.enable();
  for(let i=0;i<3;i++)f.service.submit(taskFor(ref,m.model));
  await f.service.idle();f.service.submit(taskFor(ref,m.model));await f.service.idle();
  expect(m.state.sent).toBe(1);expect(f.direct('status').used).toBe(1);
 });

 it('counts model output that fails validation and drops unsafe facts',async()=>{
  const f=fixture(),ref=f.publish();f.enable();
  const garbage=fakeModel({answer:{ok:true,text:'sure, here you go'}});
  f.service.submit(taskFor(ref,garbage.model));await f.service.idle();
  expect(f.direct('export')).toEqual([]);
  expect(f.direct('status').counters).toMatchObject({sent:1,'drop:schema':1});
 });

 it('does not send a message that looks like it holds a secret, and does not spend the quota',async()=>{
  const f=fixture(),ref=f.publish(),m=fakeModel();f.enable();
  f.service.submit(taskFor(ref,m.model,'我的密码是 hunter2'));await f.service.idle();
  expect(m.state.prepared).toBe(0);expect(m.state.sent).toBe(0);
  expect(f.direct('status')).toMatchObject({used:0,counters:{'skip:secret':1}});
 });

 it('does not send when the final request has no output limit, and does not spend the quota',async()=>{
  const f=fixture(),ref=f.publish(),m=fakeModel({noLimit:true});f.enable();
  f.service.submit(taskFor(ref,m.model));await f.service.idle();
  expect(m.state.sent).toBe(0);
  expect(f.direct('status')).toMatchObject({used:0,counters:{'skip:no-output-limit':1}});
 });

 it('cancels when the model profile changed before sending',async()=>{
  const f=fixture(),ref=f.publish();f.enable();
  const m=fakeModel({current:()=>{throw new Error('MEMORY_RUN_PROFILE_CHANGED')}});
  f.service.submit(taskFor(ref,m.model));await f.service.idle();
  expect(m.state.prepared).toBe(0);
  expect(f.direct('status')).toMatchObject({used:0,counters:{'cancel:profile-changed':1}});
 });

 it.each([['quota'],['rate-limit']] as const)('stops for the day on %s and does not send later tasks',async kind=>{
  const f=fixture(),first=f.publish(),second=f.publish();f.enable();
  const m=fakeModel({answer:{ok:false,kind}});
  f.service.submit(taskFor(first,m.model));await f.service.idle();
  expect(f.direct('status')).toMatchObject({stopped:kind,used:1});
  f.service.submit(taskFor(second,m.model));await f.service.idle();
  expect(m.state.sent).toBe(1);expect(f.direct('status').counters).toMatchObject({'refuse:stopped':1});
 });

 it.each([['timeout','error:timeout'],['network','error:network'],['http','error:http']] as const)('counts a %s as used and keeps going',async(kind,counter)=>{
  const f=fixture(),ref=f.publish(),m=fakeModel({answer:{ok:false,kind}});f.enable();
  f.service.submit(taskFor(ref,m.model));await f.service.idle();
  expect(f.direct('status')).toMatchObject({used:1,stopped:null,counters:{[counter]:1}});
  expect(f.direct('export')).toEqual([]);
 });

 it('respects the daily cap',async()=>{
  const f=fixture(),m=fakeModel();f.enable(2);
  for(let i=0;i<4;i++)f.service.submit(taskFor(f.publish(),m.model));
  await f.service.idle();
  expect(m.state.sent).toBe(2);expect(f.direct('status').counters).toMatchObject({'refuse:cap-reached':2});
 });

 it('runs tasks one at a time and drops tasks beyond the queue limit',async()=>{
  const f=fixture(1),g=gate();f.enable();
  f.service.submit(taskFor(f.publish(),gatedModel(g)));await g.started;
  const queued=fakeModel(),dropped=fakeModel();
  f.service.submit(taskFor(f.publish(),queued.model));
  f.service.submit(taskFor(f.publish(),dropped.model));
  await new Promise(r=>setTimeout(r,20));
  expect(f.direct('status').counters).toMatchObject({'cancel:queue-full':1});
  g.release();await f.service.idle();
  expect(queued.state.sent).toBe(1);expect(dropped.state.sent).toBe(0);
 });

 describe('cancellation',()=>{
  it('turning the switch off cancels the in-flight request and its late result is not stored',async()=>{
   const f=fixture(),ref=f.publish(),g=gate();f.enable();
   f.service.submit(taskFor(ref,gatedModel(g)));await g.started;
   const status=f.direct('status');
   await f.service.configure({enabled:false,dailyCap:50,expectedRevision:status.revision});
   await f.service.idle();g.release();
   expect(f.direct('export')).toEqual([]);
   expect(f.direct('status')).toMatchObject({enabled:false,counters:{sent:1,'cancel:disabled':1}});
  });

  it('clearing cancels queued and in-flight work and nothing reappears',async()=>{
   const f=fixture(),first=f.publish(),second=f.publish(),g=gate(),m=fakeModel();f.enable();
   f.service.submit(taskFor(first,gatedModel(g)));await g.started;
   f.service.submit(taskFor(second,m.model));
   await f.service.clear();await f.service.idle();g.release();
   expect(m.state.sent).toBe(0);expect(f.direct('export')).toEqual([]);
   expect(f.direct('status').counters).toMatchObject({'cancel:cleared':2});
  });

  it('cancelSession cancels only that session\'s work',async()=>{
   const f=fixture(),a=f.publish(),b=f.publish(),g=gate(),m=fakeModel();f.enable();
   f.service.submit(taskFor(a,gatedModel(g),'我平时用 VS Code','session-a'));await g.started;
   f.service.submit(taskFor(b,m.model,'我平时用 VS Code','session-b'));
   f.service.cancelSession('session-a','source-changed');
   await f.service.idle();
   expect(m.state.sent).toBe(1);
   expect(f.direct('status').counters).toMatchObject({'cancel:source-changed':1});
   expect(f.direct('export')).toHaveLength(1);
  });

  it('refuses the write when the source message was edited while the request was in flight',async()=>{
   const f=fixture(),ref=f.publish(),g=gate();f.enable();
   f.service.submit(taskFor(ref,gatedModel(g)));await g.started;
   f.edit(ref);g.release();await f.service.idle();
   expect(f.direct('export')).toEqual([]);
   expect(f.direct('status').counters).toMatchObject({'discard:source-unavailable':1});
  });

  it('close cancels everything without writing',async()=>{
   const f=fixture(),ref=f.publish(),g=gate();f.enable();
   f.service.submit(taskFor(ref,gatedModel(g)));await g.started;
   f.service.close();await new Promise(r=>setTimeout(r,20));g.release();
   expect(f.direct('export')).toEqual([]);
   expect(f.direct('status').counters).not.toHaveProperty('cancel:restart');
   f.service.submit(taskFor(f.publish(),fakeModel().model));
   expect(f.direct('status').used).toBe(1);
  });
 });

 it('reports storage failures without throwing into the chat',async()=>{
  const errors:unknown[]=[];
  const service=createShadowService({transport:{shadowCommand:async()=>{throw new Error('MEMORY_TRANSACTION_FAILED')}},scopeKey:SCOPE,actorKey:ACTOR,onError:e=>errors.push(e)});
  const f=fixture(),ref=f.publish();
  expect(()=>service.submit(taskFor(ref,fakeModel().model))).not.toThrow();
  await service.idle();
  expect(errors).toHaveLength(1);
 });
});
