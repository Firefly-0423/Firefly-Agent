import type {IpcMainInvokeEvent} from 'electron';
import {describe,expect,it,vi} from 'vitest';
import {IPC} from '../../shared/ipc-channels';
import type {ShadowService} from './shadow-service';
import type {ShadowExportRecord,ShadowStatus} from './shadow-store-contracts';
import {buildShadowExport,createShadowSettingsIpc,registerShadowSettingsIpc,SHADOW_EXPORT_FORMAT,shadowPanelState} from './shadow-settings-ipc';

const event=(trusted=true)=>({trusted}) as unknown as IpcMainInvokeEvent;
const status=(patch:Partial<ShadowStatus>={}):ShadowStatus=>({enabled:false,dailyCap:50,revision:3,clearGeneration:0,day:'2026-10-15',used:2,stopped:null,records:1,counters:{sent:2,'skip:secret':1},...patch});
const record:ShadowExportRecord={
 candidate:{attribute:'tool',value:'VS Code',polarity:'positive',status:'needs-confirmation',evidence:{messageId:'message-1',quote:'我平时用 VS Code'},reason:'stated directly'},
 sourceRef:{sourceId:'source-1',revision:2,binding:{providerId:'desktop-chat-user-v1',sessionId:'session-a',messageId:'message-1',contentRevision:1,generation:'g1'}},
 profile:{id:'luna',revision:1},promptVersion:'m-shadow-prompt-v1',recordedAt:1760000000000,
};

function fixture(overrides:Partial<Record<keyof ShadowService,unknown>>={},options:{service?:boolean}={}){
 const service={
  status:vi.fn(async()=>status()),configure:vi.fn(async()=>status({enabled:true,revision:4})),clear:vi.fn(async()=>status({records:0,revision:4})),
  exportRecords:vi.fn(async()=>[record]),...overrides,
 } as unknown as ShadowService;
 const written:Array<[string,string]>=[];
 const chooseExportPath=vi.fn(async(name:string)=>'C:\\out\\'+name);
 const handlers=createShadowSettingsIpc({
  ipc:{handle:()=>undefined},authorize:e=>(e as unknown as {trusted:boolean}).trusted,service:async()=>options.service===false?null:service,
  chooseExportPath,writeFile:async(p,c)=>{written.push([p,c])},clock:()=>Date.UTC(2026,9,15,8),
 });
 return {service:service as unknown as Record<string,ReturnType<typeof vi.fn>>,handlers,written,chooseExportPath};
}

describe('shadow settings IPC',()=>{
 it('registers exactly the four channels',()=>{
  const channels:string[]=[];
  registerShadowSettingsIpc({ipc:{handle:channel=>{channels.push(channel)}},authorize:()=>true,service:async()=>null,chooseExportPath:async()=>undefined,writeFile:async()=>undefined});
  expect(channels.sort()).toEqual([IPC.MEMORY_SHADOW_CLEAR,IPC.MEMORY_SHADOW_CONFIGURE,IPC.MEMORY_SHADOW_EXPORT,IPC.MEMORY_SHADOW_STATE].sort());
 });

 it('returns the state with only whitelisted fields and known counters',async()=>{
  const f=fixture({status:vi.fn(async()=>({...status(),counters:{sent:2,'skip:secret':1,'evil:counter':9,secretText:1},extra:'MESSAGE TEXT'}))});
  const result=await f.handlers.state(event());
  expect(result).toEqual({ok:true,state:{available:true,enabled:false,dailyCap:50,revision:3,day:'2026-10-15',used:2,stopped:null,records:1,counters:{sent:2,'skip:secret':1}}});
  expect(JSON.stringify(result)).not.toContain('MESSAGE TEXT');
 });

 it('reports the feature as unavailable when the backend has no shadow storage',async()=>{
  const f=fixture({}, {service:false});
  expect(await f.handlers.state(event())).toMatchObject({ok:true,state:{available:false,enabled:false}});
  expect(await f.handlers.clear(event())).toEqual({ok:false,error:'SHADOW_UNAVAILABLE'});
  expect(await f.handlers.exportRecords(event())).toEqual({ok:false,error:'SHADOW_UNAVAILABLE'});
  expect(await f.handlers.configure(event(),{enabled:true,dailyCap:10,expectedRevision:0})).toEqual({ok:false,error:'SHADOW_UNAVAILABLE'});
 });

 it('refuses every call from an untrusted sender without touching the service or the disk',async()=>{
  const f=fixture();const bad=event(false);
  expect(await f.handlers.state(bad)).toEqual({ok:false,error:'SHADOW_FORBIDDEN'});
  expect(await f.handlers.configure(bad,{enabled:true,dailyCap:10,expectedRevision:0})).toEqual({ok:false,error:'SHADOW_FORBIDDEN'});
  expect(await f.handlers.clear(bad)).toEqual({ok:false,error:'SHADOW_FORBIDDEN'});
  expect(await f.handlers.exportRecords(bad)).toEqual({ok:false,error:'SHADOW_FORBIDDEN'});
  for(const fn of Object.values(f.service))expect(fn).not.toHaveBeenCalled();
  expect(f.chooseExportPath).not.toHaveBeenCalled();expect(f.written).toEqual([]);
 });

 it('does not reveal input validation details to an untrusted sender',async()=>{
  const f=fixture();
  expect(await f.handlers.configure(event(false),{enabled:'yes'})).toEqual({ok:false,error:'SHADOW_FORBIDDEN'});
 });

 it.each([
  ['a missing field',{enabled:true,dailyCap:10}],
  ['an extra field',{enabled:true,dailyCap:10,expectedRevision:0,note:'x'}],
  ['a non-boolean switch',{enabled:'yes',dailyCap:10,expectedRevision:0}],
  ['a zero cap',{enabled:true,dailyCap:0,expectedRevision:0}],
  ['a cap above the maximum',{enabled:true,dailyCap:1001,expectedRevision:0}],
  ['a fractional cap',{enabled:true,dailyCap:1.5,expectedRevision:0}],
  ['a negative revision',{enabled:true,dailyCap:10,expectedRevision:-1}],
  ['null',null],
  ['an array',[]],
 ])('rejects a malformed configure request: %s',async(_label,input)=>{
  const f=fixture();
  expect(await f.handlers.configure(event(),input)).toEqual({ok:false,error:'SHADOW_INPUT_INVALID'});
  expect(f.service.configure).not.toHaveBeenCalled();
 });

 it('passes a valid configure request to the service and returns the new state',async()=>{
  const f=fixture();
  expect(await f.handlers.configure(event(),{enabled:true,dailyCap:20,expectedRevision:3})).toMatchObject({ok:true,state:{enabled:true,revision:4}});
  expect(f.service.configure).toHaveBeenCalledWith({enabled:true,dailyCap:20,expectedRevision:3});
 });

 it('maps a stale revision and other failures to safe codes without leaking messages',async()=>{
  const conflict=fixture({configure:vi.fn(async()=>{throw new Error('MEMORY_REVISION_CONFLICT')})});
  expect(await conflict.handlers.configure(event(),{enabled:true,dailyCap:20,expectedRevision:1})).toEqual({ok:false,error:'SHADOW_REVISION_CONFLICT'});
  const broken=fixture({clear:vi.fn(async()=>{throw new Error('C:\\secret\\path leaked')})});
  expect(await broken.handlers.clear(event())).toEqual({ok:false,error:'SHADOW_FAILED'});
 });

 it('clears through the service',async()=>{
  const f=fixture();
  expect(await f.handlers.clear(event())).toMatchObject({ok:true,state:{records:0}});
  expect(f.service.clear).toHaveBeenCalledTimes(1);
 });
});

describe('shadow export',()=>{
 it('asks where to save, then writes the records the user can review',async()=>{
  const f=fixture();
  expect(await f.handlers.exportRecords(event())).toEqual({ok:true,canceled:false,count:1});
  expect(f.chooseExportPath).toHaveBeenCalledWith('firefly-shadow-memory-2026-10-15.json');
  expect(f.written).toHaveLength(1);
  const [target,content]=f.written[0];
  expect(target).toBe('C:\\out\\firefly-shadow-memory-2026-10-15.json');
  expect(JSON.parse(content)).toMatchObject({format:SHADOW_EXPORT_FORMAT,exportedAt:'2026-10-15T08:00:00.000Z',records:[{
   attribute:'tool',value:'VS Code',polarity:'positive',status:'needs-confirmation',quote:'我平时用 VS Code',reason:'stated directly',
   sourceRef:{sourceId:'source-1',revision:2},profile:{id:'luna',revision:1},promptVersion:'m-shadow-prompt-v1',recordedAt:1760000000000,
  }]});
 });

 it('writes nothing when the user cancels the dialog',async()=>{
  const f=fixture();f.chooseExportPath.mockResolvedValueOnce(undefined as unknown as string);
  expect(await f.handlers.exportRecords(event())).toEqual({ok:true,canceled:true});
  expect(f.written).toEqual([]);
 });

 it('the file holds only the candidate fields: no chat text, no internal key material',()=>{
  const content=buildShadowExport([record],1760000000000);
  const entry=JSON.parse(content).records[0];
  expect(Object.keys(entry).sort()).toEqual(['attribute','polarity','profile','promptVersion','quote','reason','recordedAt','sourceRef','status','value']);
  expect(content).not.toContain('previousAssistant');
 });

 it('state projection drops anything outside the declared counters',()=>{
  expect(shadowPanelState(status({counters:{sent:1,'unknown:x':3}as never})).counters).toEqual({sent:1});
 });
});
