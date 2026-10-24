import {createServer,type Server} from "node:http";
import type {AddressInfo} from "node:net";
import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import type {ProgressExtractDeps} from "./learn-progress-extractor";
import {extractProgress,formatQuizEvidence} from "./learn-progress-extractor";

let server:Server;
let port=0;
let lastBody="";

beforeAll(async()=>{
 server=createServer((request,response)=>{
  let body="";
  request.on("data",chunk=>{body+=chunk.toString()});
  request.on("end",()=>{
   lastBody=body;
   const route=request.url;
   if(route==="/fail"){response.writeHead(500,{"content-type":"application/json"});response.end(JSON.stringify({error:"synthetic"}));return}
   if(route==="/bad-json"){response.writeHead(200,{"content-type":"text/plain"});response.end("not json");return}
   response.writeHead(200,{"content-type":"application/json"});
   if(route==="/text"){response.end(JSON.stringify({route:"text"}));return}
   if(route==="/empty"){response.end(JSON.stringify({route:"empty"}));return}
   if(route==="/filter"){response.end(JSON.stringify({route:"filter"}));return}
   if(route==="/nonsense"){response.end(JSON.stringify({route:"nonsense"}));return}
   response.end(JSON.stringify({route:"structured"}));
  });
 });
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",()=>resolve()));
 port=(server.address() as AddressInfo).port;
});
afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()))});

function deps(route:string,overrides:Partial<ProgressExtractDeps>={}):ProgressExtractDeps{
 const request={url:`http://127.0.0.1:${port}${route}`,method:"POST" as const,headers:{"content-type":"application/json"},body:""};
 const adapter={
  id:"synthetic",
  transport:"openai" as const,
  capability:{} as never,
  buildRequest:vi.fn((req:unknown,cfg:unknown)=>({...request,body:JSON.stringify({req,cfg})})),
  parseResponse:vi.fn((raw:unknown)=>{
   const value=raw as {route:string};
   if(value.route==="text")return{text:'before {"hasMeaningfulChange":true,"topic":"Text topic"} after'};
   if(value.route==="empty")return{text:"  "};
   if(value.route==="filter")return{text:"structured",structuredValue:{hasMeaningfulChange:true,topic:5,section:"S",masteryDelta:"10",status:"invalid",unresolvedQuestionsAdded:["keep",2],unresolvedQuestionsResolved:["done",null],nextStep:false}};
   if(value.route==="nonsense")return{text:"structured",structuredValue:42};
   return{text:"structured",structuredValue:{hasMeaningfulChange:true,topic:"Topic",section:"Section",masteryDelta:10,status:"learning",unresolvedQuestionsAdded:["question"],unresolvedQuestionsResolved:["resolved"],nextStep:"Next"}};
  }),
  appendToolResults:vi.fn(),
  buildStreamRequest:vi.fn(),
  parseStreamEvent:vi.fn(),
 };
 return{
  adapter:adapter as never,
  cfg:{provider:"Synthetic",baseUrl:"http://127.0.0.1",model:"synthetic-model",apiKey:"key"},
  systemPrompt:"SYSTEM",
  userMessage:"USER",
  assistantMessage:"ASSISTANT",
  ...overrides,
 };
}

describe("formatQuizEvidence",()=>{
 it("formats correct, incorrect and pending answers with their evidence",()=>{
  expect(formatQuizEvidence([
   {questionId:"q1",learningObjective:"Objective A",userAnswer:"A",grading:"correct"},
   {questionId:"q2",learningObjective:"Objective B",userAnswer:[1,2],grading:"incorrect"},
   {questionId:"q3",learningObjective:"Objective C",userAnswer:true,grading:"pending_model"},
  ])).toBe("- 知识点「Objective A」：答对\n- 知识点「Objective B」：答错（作答 [1,2]）\n- 知识点「Objective C」：简答待讲评");
 });
 it("returns an empty string for no evidence",()=>{
  expect(formatQuizEvidence([])).toBe("");
 });
});

describe("extractProgress",()=>{
 it("returns a validated structured update and builds the extraction request",async()=>{
  const input=deps("/structured");
  const result=await extractProgress(input);
  expect(result).toEqual({hasMeaningfulChange:true,topic:"Topic",section:"Section",masteryDelta:10,status:"learning",unresolvedQuestionsAdded:["question"],unresolvedQuestionsResolved:["resolved"],nextStep:"Next"});
  const [request,cfg]=vi.mocked(input.adapter.buildRequest).mock.calls[0];
  expect(cfg).toBe(input.cfg);
  expect(request).toMatchObject({model:"synthetic-model",maxTokens:1024,temperature:0.1,stream:false});
  expect(request.messages[0]).toEqual({role:"system",content:expect.stringContaining("SYSTEM\n\n")});
  expect((request.messages[0].content as string)).toContain("学习进度追踪助手");
  expect(request.messages[1]).toEqual({role:"user",content:"USER"});
  expect(request.messages[2]).toEqual({role:"assistant",content:"ASSISTANT"});
  expect(lastBody).toContain("synthetic-model");
 });
 it("appends quiz evidence to the user message",async()=>{
  const input=deps("/structured",{
   quizEvidence:[{questionId:"q",learningObjective:"Objective",userAnswer:"wrong",grading:"incorrect"}],
  });
  await extractProgress(input);
  const [request]=vi.mocked(input.adapter.buildRequest).mock.calls[0];
  expect(request.messages[1].content).toContain("USER\n\n【本轮抽查实测数据】\n- 知识点「Objective」：答错（作答 wrong）");
 });
 it("falls back to extracting JSON from response text",async()=>{
  const result=await extractProgress(deps("/text"));
  expect(result).toMatchObject({hasMeaningfulChange:true,topic:"Text topic"});
 });
 it("returns null for empty text, invalid JSON, non-object output and HTTP errors",async()=>{
  expect(await extractProgress(deps("/empty"))).toBeNull();
  expect(await extractProgress(deps("/bad-json"))).toBeNull();
  expect(await extractProgress(deps("/nonsense"))).toBeNull();
  expect(await extractProgress(deps("/fail"))).toBeNull();
 });
 it("drops invalid optional fields while keeping the boolean",async()=>{
  expect(await extractProgress(deps("/filter"))).toEqual({
   hasMeaningfulChange:true,section:"S",unresolvedQuestionsAdded:["keep"],unresolvedQuestionsResolved:["done"],
   topic:undefined,masteryDelta:undefined,status:undefined,nextStep:undefined,
  });
 });
 it("returns null instead of throwing when request construction fails",async()=>{
  const input=deps("/structured");
  vi.mocked(input.adapter.buildRequest).mockImplementation(()=>{throw new Error("build failed")});
  await expect(extractProgress(input)).resolves.toBeNull();
 });
 it("returns null for an unparseable request URL",async()=>{
  const input=deps("/structured");
  vi.mocked(input.adapter.buildRequest).mockReturnValue({url:"not a url",method:"POST",headers:{},body:""});
  await expect(extractProgress(input)).resolves.toBeNull();
 });
 it("returns null instead of throwing when response parsing fails",async()=>{
  const input=deps("/structured");
  vi.mocked(input.adapter.parseResponse).mockImplementation(()=>{throw new Error("parse failed")});
  await expect(extractProgress(input)).resolves.toBeNull();
 });
});
