import {beforeEach,describe,expect,it,vi} from "vitest";

const mocks=vi.hoisted(()=>({
 registry:{getAll:vi.fn(),getById:vi.fn(),isAvailable:vi.fn(),getBody:vi.fn(),getEnabled:vi.fn()},
 parseSlashCommand:vi.fn(),
}));
vi.mock("./index",()=>({parseSlashCommand:mocks.parseSlashCommand,skillRegistry:mocks.registry}));

import {resolveSlashActivation} from "./slash-activation";

type Message={role:string;content:string};
function skill(overrides:Record<string,unknown>={}){
 return{id:"demo",name:"Demo",description:"",dirPath:"",bodyPath:"",references:[],enabled:true,source:"builtin",...overrides};
}
function arrange(options:{skill?:ReturnType<typeof skill>|undefined;available?:boolean;body?:string|null;enabled?:string[];parsed?:{hit:boolean;skillId?:string}}={}){
 const selected=options.skill;
 mocks.registry.getAll.mockReturnValue(selected?[selected]:[]);
 mocks.registry.getById.mockReturnValue(selected);
 mocks.registry.isAvailable.mockReturnValue(options.available??true);
 mocks.registry.getBody.mockReturnValue(options.body===undefined?"BODY":options.body);
 mocks.registry.getEnabled.mockReturnValue((options.enabled??[]).map(id=>({id,enabled:true})));
 mocks.parseSlashCommand.mockReturnValue(options.parsed??{hit:true,skillId:"demo"});
}

beforeEach(()=>{vi.clearAllMocks()});

describe("resolveSlashActivation",()=>{
 it("returns empty when there is no user message or content is not a string",()=>{
  arrange();
  expect(resolveSlashActivation([])).toBe("");
  expect(resolveSlashActivation([{role:"assistant",content:"/demo"}])).toBe("");
  expect(resolveSlashActivation([{role:"user",content:1 as unknown as string}])).toBe("");
 });
 it("returns empty when the message is not a known slash command",()=>{
  arrange({parsed:{hit:false}});
  expect(resolveSlashActivation([{role:"user",content:"/unknown"}])).toBe("");
  expect(mocks.registry.getById).not.toHaveBeenCalled();
 });
 it("injects the skill body when the skill is enabled and available",()=>{
  arrange({skill:skill()});
  expect(resolveSlashActivation([{role:"user",content:"/demo please"}])).toBe("\n\n---\n\n[已激活 skill: demo]\nBODY");
  expect(mocks.parseSlashCommand).toHaveBeenCalledWith("/demo please",["demo"]);
 });
 it("returns empty without rewriting when the body cannot be read",()=>{
  arrange({skill:skill(),body:null});
  const messages:Message[]=[{role:"user",content:"/demo"}];
  expect(resolveSlashActivation(messages)).toBe("");
  expect(messages[0].content).toBe("/demo");
 });
 it("rewrites the last user message when the skill does not exist",()=>{
  arrange({skill:undefined,enabled:["other","second"]});
  const messages:Message[]=[{role:"user",content:"before"},{role:"user",content:"/demo"},{role:"assistant",content:"reply"}];
  expect(resolveSlashActivation(messages)).toBe("");
  expect(messages[1]).toEqual({role:"user",content:"[系统提示：skill 未启用、不存在或当前模式不可用: demo。可用 skill: other, second]"});
  expect(messages[0].content).toBe("before");
 });
 it("uses (无) when no skills are available",()=>{
  arrange({skill:undefined,enabled:[]});
  const messages:Message[]=[{role:"user",content:"/demo"}];
  resolveSlashActivation(messages);
  expect(messages[0].content).toContain("可用 skill: (无)");
 });
 it("rewrites when the skill is disabled or unavailable",()=>{
  arrange({skill:skill({enabled:false})});
  let messages:Message[]=[{role:"user",content:"/demo"}];
  resolveSlashActivation(messages);
  expect(messages[0].content).toContain("未启用");
  arrange({skill:skill(),available:false});
  messages=[{role:"user",content:"/demo"}];
  resolveSlashActivation(messages);
  expect(messages[0].content).toContain("未启用");
 });
 it("allows a skill in every mode when no mode is provided",()=>{
  arrange({skill:skill({modes:["work"]})});
  expect(resolveSlashActivation([{role:"user",content:"/demo"}])).toContain("已激活");
 });
 it("enforces the skill mode whitelist",()=>{
  arrange({skill:skill({modes:["work"]})});
  const messages:Message[]=[{role:"user",content:"/demo"}];
  expect(resolveSlashActivation(messages,"code")).toBe("");
  expect(messages[0].content).toContain("当前模式不可用");
  expect(resolveSlashActivation([{role:"user",content:"/demo"}],"work")).toContain("已激活");
 });
 it("lets mode overrides win over the skill whitelist",()=>{
  arrange({skill:skill({modes:["work"]})});
  expect(resolveSlashActivation([{role:"user",content:"/demo"}],"code",{demo:{code:true}})).toContain("已激活");
  arrange({skill:skill()});
  const messages:Message[]=[{role:"user",content:"/demo"}];
  expect(resolveSlashActivation(messages,"work",{demo:{work:false}})).toBe("");
  expect(messages[0].content).toContain("未启用");
 });
});
