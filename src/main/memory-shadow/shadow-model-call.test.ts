import {afterEach,describe,expect,it,vi} from 'vitest';
import {getAdapterForConfig} from '../orchestrator/vendors';
import {setVendorRuntimeSettingsGetter} from '../orchestrator/vendors/runtime-settings';
import type {VendorConfig} from '../orchestrator/vendors/types';
import {classifyShadowHttpFailure,createShadowModel,hasOutputLimit,SHADOW_MAX_OUTPUT_TOKENS} from './shadow-model-call';

afterEach(()=>setVendorRuntimeSettingsGetter(()=>({})));

const openai:VendorConfig={provider:'custom-cloud',baseUrl:'https://example.invalid/v1',model:'test-model',apiKey:'sk-test-key-0000000000'} as VendorConfig;
const anthropic:VendorConfig={provider:'anthropic',baseUrl:'https://example.invalid',model:'claude-test',apiKey:'sk-ant-test-0000000000'} as VendorConfig;
const make=(config:VendorConfig,fetchImpl?:typeof fetch)=>createShadowModel({profile:{id:'p',revision:1},config,adapter:getAdapterForConfig(config),assertCurrent:()=>undefined,fetchImpl});
const reply=(status:number,body:unknown)=>new Response(typeof body==='string'?body:JSON.stringify(body),{status});
const okBody={id:'x',choices:[{index:0,message:{role:'assistant',content:'{"facts":[]}'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:4}};

describe('output limit check on the final request body',()=>{
 it.each([
  ['a positive max_tokens','{"max_tokens":800}',true],
  ['max_output_tokens','{"max_output_tokens":800}',true],
  ['max_completion_tokens','{"max_completion_tokens":800}',true],
  ['no limit field','{"model":"m"}',false],
  ['a zero limit','{"max_tokens":0}',false],
  ['an absurdly large limit','{"max_tokens":1000000}',false],
  ['a non-numeric limit','{"max_tokens":"800"}',false],
  ['a streaming request','{"max_tokens":800,"stream":true}',false],
  ['a body that is not JSON','not json',false],
 ])('%s',(_label,body,expected)=>expect(hasOutputLimit(body)).toBe(expected));
});

describe('shadow model preparation with the real adapters',()=>{
 it.each([['OpenAI-compatible',openai],['Anthropic',anthropic]])('%s request carries the output limit',(_label,config)=>{
  const call=make(config).prepare('system text','user text');
  expect(call.ok).toBe(true);
 });

 it('refuses to prepare when a custom endpoint has the max-token switch turned off',()=>{
  setVendorRuntimeSettingsGetter(()=>({disableMaxToken:true}));
  expect(make(openai).prepare('s','u')).toEqual({ok:false,reason:'no-output-limit'});
 });

 it('sends the configured limit, the two messages and no extra body',async()=>{
  const fetchImpl=vi.fn(async()=>reply(200,okBody));
  const call=make(openai,fetchImpl as unknown as typeof fetch).prepare('system text','user text');
  if(!call.ok)throw new Error('expected ok');
  await call.send(new AbortController().signal);
  const [url,init]=fetchImpl.mock.calls[0] as unknown as [string,RequestInit];
  const body=JSON.parse(init.body as string);
  expect(url).toContain('example.invalid');
  expect(body).toMatchObject({model:'test-model',max_tokens:SHADOW_MAX_OUTPUT_TOKENS,messages:[{role:'system',content:'system text'},{role:'user',content:'user text'}]});
  expect(body.stream).not.toBe(true);expect(body.tools).toBeUndefined();
 });
});

describe('sending',()=>{
 const send=async(response:(init:RequestInit)=>Promise<Response>|Response,signal=new AbortController().signal,timeoutMs?:number)=>{
  const model=createShadowModel({profile:{id:'p',revision:1},config:openai,adapter:getAdapterForConfig(openai),assertCurrent:()=>undefined,fetchImpl:(async(_url:string,init:RequestInit)=>response(init)) as unknown as typeof fetch,timeoutMs});
  const call=model.prepare('s','u');if(!call.ok)throw new Error('expected ok');return call.send(signal);
 };

 it('returns the text and usage on success',async()=>{
  expect(await send(()=>reply(200,okBody))).toMatchObject({ok:true,text:'{"facts":[]}',usage:{input:10,output:4}});
 });

 it.each([
  ['402 is quota',402,'payment required','quota'],
  ['429 is a rate limit',429,'slow down','rate-limit'],
  ['429 saying insufficient quota is quota',429,'{"error":{"code":"insufficient_quota"}}','quota'],
  ['403 saying the balance is empty is quota',403,'余额不足','quota'],
  ['400 saying quota exceeded is quota',400,'You exceeded your current quota','quota'],
  ['500 is a plain http error',500,'oops','http'],
  ['401 is a plain http error',401,'bad key','http'],
 ] as const)('%s',async(_label,status,text,kind)=>{
  expect(await send(()=>reply(status,text))).toEqual({ok:false,kind});
 });

 it('treats an unparsable success response as an http error',async()=>{
  expect(await send(()=>reply(200,'<html>nope</html>'))).toEqual({ok:false,kind:'http'});
 });

 it('maps a network failure, a timeout and a cancellation separately',async()=>{
  expect(await send(()=>{throw new TypeError('fetch failed')})).toEqual({ok:false,kind:'network'});
  const hang=(init:RequestInit)=>new Promise<Response>((_,reject)=>init.signal!.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true}));
  expect(await send(hang,new AbortController().signal,30)).toEqual({ok:false,kind:'timeout'});
  const controller=new AbortController();controller.abort();
  expect(await send(()=>reply(200,okBody),controller.signal)).toEqual({ok:false,kind:'cancelled'});
 });

 it('never puts provider text into the result',async()=>{
  const result=await send(()=>reply(500,'SECRET_PROVIDER_TEXT sk-live-123'));
  expect(JSON.stringify(result)).not.toContain('SECRET_PROVIDER_TEXT');
 });
});

describe('request accounting and redirects',()=>{
 it('never follows redirects',async()=>{
  const fetchImpl=vi.fn(async()=>reply(200,okBody));
  const call=make(openai,fetchImpl as unknown as typeof fetch).prepare('s','u');if(!call.ok)throw new Error('expected ok');
  await call.send(new AbortController().signal);
  expect((fetchImpl.mock.calls[0] as unknown as [string,RequestInit])[1].redirect).toBe('error');
 });

 it('counts the dispatch even when the response has no usage or the request fails',async()=>{
  const dispatched:string[]=[],usages:unknown[]=[];
  const run=async(response:()=>Promise<Response>)=>{
   const model=createShadowModel({profile:{id:'p',revision:1},config:openai,adapter:getAdapterForConfig(openai),assertCurrent:()=>undefined,
    fetchImpl:(async()=>response()) as unknown as typeof fetch,onDispatch:name=>dispatched.push(name),onUsage:(_n,usage)=>usages.push(usage)});
   const call=model.prepare('s','u');if(!call.ok)throw new Error('expected ok');return call.send(new AbortController().signal);
  };
  await run(async()=>reply(200,{id:'x',choices:[{index:0,message:{role:'assistant',content:'{"facts":[]}'},finish_reason:'stop'}]}));
  await run(async()=>reply(500,'oops'));
  await run(async()=>{throw new TypeError('fetch failed')});
  expect(dispatched).toEqual(['test-model','test-model','test-model']);
  expect(usages).toEqual([]);
  await run(async()=>reply(200,okBody));
  expect(dispatched).toHaveLength(4);expect(usages).toHaveLength(1);
 });

 it('does not count a request that was cancelled before it was sent',async()=>{
  const dispatched:string[]=[];
  const model=createShadowModel({profile:{id:'p',revision:1},config:openai,adapter:getAdapterForConfig(openai),assertCurrent:()=>undefined,fetchImpl:(async()=>reply(200,okBody)) as unknown as typeof fetch,onDispatch:name=>dispatched.push(name)});
  const call=model.prepare('s','u');if(!call.ok)throw new Error('expected ok');
  const controller=new AbortController();controller.abort();
  expect(await call.send(controller.signal)).toEqual({ok:false,kind:'cancelled'});
  expect(dispatched).toEqual([]);
 });
});

describe('classifyShadowHttpFailure',()=>{
 it('does not treat an ordinary 400 as quota',()=>expect(classifyShadowHttpFailure(400,'invalid request')).toBe('http'));
});
