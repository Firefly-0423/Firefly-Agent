import {expect,it} from "vitest";
import {materializeTranscript,projectSSettlementMessages} from "./conversation-transcript-context";
import type {TranscriptEntry} from "./conversation-transcript-types";
import type {ChatMessage} from "../../shared/chat-types";

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
