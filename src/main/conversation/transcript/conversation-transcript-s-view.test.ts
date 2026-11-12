import {expect,it} from "vitest";
import {materializeTranscript,projectSSettlementMessages} from "./conversation-transcript-context";
import type {TranscriptEntry} from "./conversation-transcript-types";
import type {ChatMessage} from "../../../shared/chat-types";

const binding={runId:"s-run",assistantTurnId:"assistant",userTurnId:"user",userRevision:1,assistantEntryId:"reply"};
const user:TranscriptEntry={id:"user",seq:1,at:10,kind:"user",turnId:"user",revision:1,payload:{text:"question"}};
const reply:TranscriptEntry={id:"reply",seq:2,at:11,kind:"assistant",runId:"s-run",turnId:"assistant",roundId:"s-response",sSettlement:{version:1,userTurnId:"user",userRevision:1},payload:{role:"assistant",content:"audit original"}};
const marker=(result:"success"|"interrupted"):TranscriptEntry=>({id:"settlement",seq:3,at:12,kind:"assistant_settlement",runId:"s-run",turnId:"assistant",payload:{binding,result,safeReason:"SYNTHETIC"}});

it.each(["pending","interrupted","unknown"] as const)("%s S assistant remains raw audit but cannot enter model messages",state=>{
 const bad=marker("success");if(bad.kind!=="assistant_settlement")throw Error("BAD_FIXTURE");
 bad.payload.binding={...binding,userRevision:2};
 const entries=[user,reply,...(state==="interrupted"?[marker("interrupted")]:state==="unknown"?[bad]:[])];
 expect(materializeTranscript(entries,{get:()=>null}).messages).toEqual([{role:"user",content:"question"}]);
 expect(entries[1].payload).toEqual({role:"assistant",content:"audit original"});
});
it("durably settled success is included; metadata and rewound success are excluded",()=>{
 const entries=[user,reply,marker("success")];
 expect(materializeTranscript(entries,{get:()=>null}).messages).toEqual([{role:"user",content:"question"},{role:"assistant",content:"audit original"}]);
 entries.push({id:"rewind",seq:4,at:13,kind:"turn_rewind",payload:{anchorUserTurnId:"user",disposition:"keep_user",reason:"regenerate"}});
 expect(materializeTranscript(entries,{get:()=>null}).messages).toEqual([{role:"user",content:"question"}]);
});
it("materializes only the controlled reply when both paths wrote the same assistant turn", () => {
 const regular:TranscriptEntry={id:"regular",seq:4,at:12,kind:"assistant",runId:"chat-run",turnId:"assistant",roundId:"round-0",payload:{role:"assistant",content:"regular reply"}};
 const entries=[user,reply,marker("success"),regular];
 expect(materializeTranscript(entries,{get:()=>null}).messages).toEqual([{role:"user",content:"question"},{role:"assistant",content:"audit original"}]);
 expect(projectSSettlementMessages([{...cached,content:"regular reply"}],entries)[0].content).toBe("audit original");
});
it("excludes an ambiguous multi-controlled turn from the model view, matching the unknown projection", () => {
 const second:TranscriptEntry={...reply,id:"reply-b",seq:4,runId:"s-run-b"};
 const entries=[user,reply,marker("success"),second];
 expect(materializeTranscript(entries,{get:()=>null}).messages).toEqual([{role:"user",content:"question"}]);
 expect(projectSSettlementMessages([cached],entries)[0]).toMatchObject({content:"",sSettlement:{state:"unknown"}});
});
it("drops the regular duplicate and its tool results when the controlled entry owns the turn", () => {
 const regular:TranscriptEntry={id:"regular",seq:4,at:12,kind:"assistant",runId:"chat-run",turnId:"assistant",roundId:"round-0",payload:{role:"assistant",content:"regular reply",toolCalls:[{id:"call-1",name:"lookup",arguments:"{}"}]}};
 const result:TranscriptEntry={id:"result-1",seq:5,at:12,kind:"tool_result",payload:{assistantEntryId:"regular",toolCallId:"call-1",outcome:"success",message:{role:"tool",toolCallId:"call-1",name:"lookup",content:"ok"}}};
 const built=materializeTranscript([user,reply,marker("success"),regular,result],{get:()=>null});
 expect(built.messages).toEqual([{role:"user",content:"question"},{role:"assistant",content:"audit original"}]);
 expect(built.messageSources?.map(source=>source.id)).toEqual(["user","reply"]);
});
it("keeps every tool round when only the regular path wrote the turn", () => {
 const first:TranscriptEntry={id:"round-0",seq:3,at:12,kind:"assistant",runId:"chat-run",turnId:"assistant",roundId:"round-0",payload:{role:"assistant",content:"checking",toolCalls:[{id:"call-1",name:"lookup",arguments:"{}"}]}};
 const result:TranscriptEntry={id:"result-1",seq:4,at:12,kind:"tool_result",payload:{assistantEntryId:"round-0",toolCallId:"call-1",outcome:"success",message:{role:"tool",toolCallId:"call-1",name:"lookup",content:"ok"}}};
 const second:TranscriptEntry={id:"round-1",seq:5,at:12,kind:"assistant",runId:"chat-run",turnId:"assistant",roundId:"round-1",payload:{role:"assistant",content:"done"}};
 const built=materializeTranscript([user,first,result,second],{get:()=>null});
 expect(built.messages.map(message=>message.role)).toEqual(["user","assistant","tool","assistant"]);
 expect(built.messages.map(message=>message.content)).toEqual(["question","checking","ok","done"]);
});
const cached:ChatMessage={id:"assistant",role:"model",at:11,content:"CACHE_NOT_AUTHORITY",answersUserMessageId:"user",ttsCacheKey:"old",runSnapshot:{runId:"s-run",status:"running",updatedAt:11}};
it("canonical successful run overrides a stale cached run id without changing either source",()=>{
 const cache={...cached,runSnapshot:{...cached.runSnapshot!,runId:"stale-cache-run"}},entries=[user,reply,marker("success")],before=structuredClone({cache,entries});
 const projected=projectSSettlementMessages([cache],entries)[0];expect(projected).toMatchObject({content:"audit original",sSettlement:{state:"success",runId:"s-run"},runSnapshot:{runId:"s-run",terminalStatus:"success"}});
 expect({cache,entries}).toEqual(before);
});
it.each(["binding","duplicate"] as const)("canonical %s rejection survives a stale cached run id",reason=>{
 const bad=structuredClone(reply);if(reason==="binding")bad.sSettlement!.userRevision=2;
 const entries=[user,bad,marker("success"),...(reason==="duplicate"?[{...reply,id:"duplicate-reply",seq:4}]:[])];
 const projected=projectSSettlementMessages([{...cached,runSnapshot:{...cached.runSnapshot!,runId:"stale-cache-run"}}],entries)[0];expect(projected.content).toBe("");expect(projected.sSettlement?.state).toBe("unknown");
});
it.each(["pending","interrupted","success"] as const)("read-only %s projection overrides cache and retains exact original diagnostic text",state=>{
 const entries=[user,reply,...(state==="pending"?[]:[marker(state)])],copy=structuredClone(entries),cache=structuredClone(cached);
 const projected=projectSSettlementMessages([cached],entries)[0];
 expect(projected.sSettlement).toMatchObject({state,originalText:"audit original",assistantEntryId:"reply",runId:"s-run"});
 expect(projected.content).toBe(state==="success"?"audit original":"");
 if(state!=="success")expect(projected.ttsCacheKey).toBeUndefined();
 expect(entries).toEqual(copy);expect(cached).toEqual(cache);
});
it("projection cannot revive rewound success or accept a mismatched cache binding",()=>{
 const entries:TranscriptEntry[]=[user,reply,marker("success"),{id:"rewind",seq:4,at:13,kind:"turn_rewind",payload:{anchorUserTurnId:"user",disposition:"keep_user",reason:"regenerate"}}];
 expect(projectSSettlementMessages([cached],entries)[0].sSettlement?.state).toBe("unknown");
 expect(projectSSettlementMessages([{...cached,answersUserMessageId:"other"}],entries)[0].sSettlement?.state).toBe("unknown");
});
