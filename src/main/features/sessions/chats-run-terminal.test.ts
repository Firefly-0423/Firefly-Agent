import fs from "fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const env = vi.hoisted(() => ({ root:"", writes:0, fileWrites:0, failAt:0 }));
vi.mock("fs", async () => {
 const actual=await vi.importActual<typeof import("fs")>("fs");
 return {...actual,writeFileSync:(...args:Parameters<typeof actual.writeFileSync>)=>{env.fileWrites++;return actual.writeFileSync(...args);},renameSync:(...args:Parameters<typeof actual.renameSync>)=>{
  env.writes++; if(env.failAt && env.writes>=env.failAt) throw Error("disk full");
  return actual.renameSync(...args);
 }};
});
vi.mock("electron", () => ({app:{getPath:()=>env.root},shell:{}}));
beforeEach(()=>{ vi.resetModules(); env.writes=0; env.fileWrites=0; env.failAt=0; env.root=fs.mkdtempSync(join(tmpdir(),"run-terminal-")); });
afterEach(()=>{ vi.restoreAllMocks(); fs.rmSync(env.root,{recursive:true,force:true}); });
async function setup() {
 const store=await import("./chats-store"); store.initialize();
 const session=store.createSession({mode:"chat",initialMessages:[{id:"u",role:"user",content:"question",at:1},{id:"a",role:"model",content:"",at:2}]});
 const identity={profileId:"desktop-local-profile-v1",sessionId:session.id,assistantTurnId:"a",runId:"r"};
 expect(store.registerRun(identity)).toBe(true);
 const message={id:"a",role:"model" as const,content:"final",at:2,runSnapshot:{runId:"r",status:"terminal" as const,terminalStatus:"success" as const,updatedAt:3}};
 return {store,session,identity,message};
}
describe("Main owned final message persistence",()=>{
 it.each(["running","settling"])("keeps the owned assistant row while %s",async phase=>{
  const {store,session,identity}=await setup();
  if(phase==="settling")expect(store.beginRunSettlement(identity)).toBe(true);
  const original=store.getSession(session.id)!.messages[1];
  store.upsertMessage(session.id,{...original,content:"stale"});
  store.replaceMessagesTail(session.id,1,[{id:"insert",role:"user",content:"inserted",at:4}]);
  expect(store.getSession(session.id)?.messages.slice(1)).toEqual([original,{id:"insert",role:"user",content:"inserted",at:4}]);
 });
 it.each(["regenerate","edit"])("removes the completed reply on %s and records only its replacement",async operation=>{
  const {store,session,identity,message}=await setup();
  expect(store.commitRunTerminal(identity,message)).toBe(true);
  const user={id:"u",role:"user" as const,content:operation==="edit"?"edited":"question",at:1};
  store.replaceMessagesTail(session.id,0,[user]);
  expect(store.getSession(session.id)?.runPresentations?.a).toBeUndefined();
  const next={...identity,assistantTurnId:"new-a",runId:"next"};
  expect(store.registerRun(next)).toBe(true);
  const response={...message,id:"new-a",content:"new answer",runSnapshot:{...message.runSnapshot,runId:"next"}};
  expect(store.commitRunTerminal(next,response)).toBe(true);
  expect(store.getSession(session.id)?.messages).toEqual([user,response]);
 });
 it("removes the completed reply and its mapping when history is compacted",async()=>{
  const {store,session,identity,message}=await setup();
  expect(store.commitRunTerminal(identity,message)).toBe(true);
  const summary={id:"summary",role:"user" as const,content:"summary",at:4};
  store.replaceMessages(session.id,[summary]);
  expect(store.getSession(session.id)?.messages).toEqual([summary]);
  expect(store.getRunStatus(session.id,"a")).toBeUndefined();
  expect(store.getSession(session.id)?.runPresentations?.a).toBeUndefined();
 });
 it("rejects late running snapshots but accepts normal updates to a finished row",async()=>{
  const {store,session,identity,message}=await setup();
  expect(store.commitRunTerminal(identity,message)).toBe(true);
  const stale={...message,content:"stale",runSnapshot:{...message.runSnapshot,status:"running" as const}};
  store.upsertMessage(session.id,stale);
  store.appendMessage(session.id,stale);
  store.replaceMessagesTail(session.id,1,[stale]);
  expect(store.getSession(session.id)?.messages.slice(1)).toEqual([message]);
  store.upsertMessage(session.id,{...message,content:"updated"});
  expect(store.getSession(session.id)?.messages.slice(1)).toEqual([{...message,content:"updated"}]);
 });
 it("recovers visible progress and tool results after restart without accepting writes after settlement",async()=>{
  let {store,session,identity,message}=await setup();
  const checkpoint={...message,content:"partial",toolExecutions:[{id:"tool",name:"read_file",status:"success" as const,result:"kept"}],
   runSnapshot:{runId:"r",status:"running" as const,updatedAt:4}};
  expect(store.writeRunCheckpoint(identity,checkpoint)).toBe(true);
  expect(store.getRunStatus(session.id,"a")).toMatchObject({phase:"running",seq:2});
  vi.resetModules();store=await import("./chats-store");store.initialize();
  expect(store.getRunStatus(session.id,"a")).toMatchObject({phase:"interrupted",seq:3});
  expect(store.getSession(session.id)?.messages[1]).toEqual(checkpoint);
  expect(store.beginRunSettlement(identity)).toBe(true);
  expect(store.writeRunCheckpoint(identity,{...checkpoint,content:"late"})).toBe(false);
  expect(store.commitRunTerminal(identity,message)).toBe(true);
  expect(store.getSession(session.id)?.messages[1]).toEqual(message);
 });
 it("writes temporary run progress only in memory",async()=>{
  const store=await import("./chats-store");store.initialize();
  const session=store.createSession({mode:"chat",temporary:true});
  const identity={profileId:store.RUN_PRESENTATION_PROFILE_ID,sessionId:session.id,assistantTurnId:"temp",runId:"r"};
  expect(store.registerRun(identity)).toBe(true);
  const before=[env.fileWrites,env.writes];
  expect(store.writeRunCheckpoint(identity,{id:"temp",role:"model",content:"visible",at:1,runSnapshot:{runId:"r",status:"running",updatedAt:2}})).toBe(true);
  expect(store.getSession(session.id)?.messages[0].content).toBe("visible");
  expect([env.fileWrites,env.writes]).toEqual(before);
 });
 it("keeps one frozen pending value after write failure and recovers it on startup without execution",async()=>{
  let {store,session,identity,message}=await setup();
  env.writes=0; env.failAt=2;
  expect(()=>store.commitRunTerminal(identity,message)).toThrow("disk full");
  expect(store.getRunStatus(session.id,"a")?.phase).toBe("settling");
  env.failAt=0; vi.resetModules();
  store=await import("./chats-store"); store.initialize();
  expect(store.getSession(session.id)?.messages.filter(row=>row.id==="a")).toEqual([message]);
  expect(store.getRunStatus(session.id,"a")?.phase).toBe("finished");
 });
 it("does not recreate a session deleted during settlement",async()=>{
  const {store,session,identity,message}=await setup();
  store.deleteSession(session.id);
  expect(store.commitRunTerminal(identity,message)).toBe(false);
  expect(store.getSession(session.id)).toBeNull();
 });
});

describe("terminal recovery boundaries",()=>{
 it("keeps pending startup recovery settling after repeated failure and retries without replacing the frozen message",async()=>{
  vi.useFakeTimers();
  try {
   let {store,session,identity,message}=await setup();
   env.writes=0; env.failAt=2;
   expect(()=>store.commitRunTerminal(identity,message)).toThrow("disk full");
   vi.resetModules(); store=await import("./chats-store"); store.initialize();
   expect(store.getRunStatus(session.id,"a")?.phase).toBe("settling");
   env.failAt=0; await vi.advanceTimersByTimeAsync(1000);
   expect(store.getSession(session.id)?.messages.filter(row=>row.id==="a")).toEqual([message]);
   expect(store.getRunStatus(session.id,"a")?.phase).toBe("finished");
  } finally { vi.useRealTimers(); }
 });
 it("retries the first persisted value even when a later caller supplies different text",async()=>{
  const {store,session,identity,message}=await setup();
  env.writes=0; env.failAt=2;
  expect(()=>store.commitRunTerminal(identity,message)).toThrow("disk full");
  env.failAt=0;
  expect(store.commitRunTerminal(identity,{...message,content:"replacement"})).toBe(true);
  expect(store.getSession(session.id)?.messages.filter(row=>row.id==="a")).toEqual([message]);
 });
 it("deletion cancels scheduled writes and cannot recreate the session",async()=>{
  vi.useFakeTimers();
  try {
   const {store,session,identity,message}=await setup();
   env.writes=0; env.failAt=2;
   const done=vi.fn();store.retryRunTerminal(identity,message,done);
   env.failAt=0; store.deleteSession(session.id);
   await vi.advanceTimersByTimeAsync(3000);
   expect(store.getSession(session.id)).toBeNull();
   expect(done).toHaveBeenCalledExactlyOnceWith(false);
   expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
 });
 it("temporary sessions never add persistence writes for their terminal outbox",async()=>{
  const store=await import("./chats-store");store.initialize();
  const session=store.createSession({mode:"chat",temporary:true});
  const identity={profileId:store.RUN_PRESENTATION_PROFILE_ID,sessionId:session.id,assistantTurnId:"a",runId:"r"};
  const writes=env.writes; const fileWrites=env.fileWrites;
  expect(store.registerRun(identity)).toBe(true);
  expect(store.commitRunTerminal(identity,{id:"a",role:"model",content:"private",at:1,runSnapshot:{runId:"r",status:"terminal",updatedAt:2}})).toBe(true);
  expect(env.writes).toBe(writes); expect(env.fileWrites).toBe(fileWrites);
 });
});
