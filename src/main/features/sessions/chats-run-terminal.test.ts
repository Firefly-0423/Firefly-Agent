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
 it("blocks stale page writes and deletion through tail replacement while keeping unrelated inserted rows",async()=>{
  const {store,session,identity,message}=await setup();
  expect(store.commitRunTerminal(identity,message)).toBe(true);
  store.upsertMessage(session.id,{...message,content:"stale"});
  store.appendMessage(session.id,{...message,content:"duplicate"});
  store.replaceMessagesTail(session.id,1,[{id:"insert",role:"user",content:"inserted",at:4}]);
  expect(store.getSession(session.id)?.messages).toEqual([{id:"u",role:"user",content:"question",at:1},message,{id:"insert",role:"user",content:"inserted",at:4}]);
  expect(store.getRunStatus(session.id,"a")).toEqual({sessionId:session.id,assistantTurnId:"a",runId:"r",seq:3,phase:"finished",message});
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
