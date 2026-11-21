import { expect, it } from "vitest";
import { applyAgentRoundBoundary, reduceDisplayAnswer, displayTerminal, finishDisplayAnswer, reduceToolDisplay } from "./run-display";
import type { AguiEvent } from "./run-display";

it.each([
  ["success", true, "completed", "answer"], ["success", false, "completed", ""],
  ["cancelled", true, "cancelled", ""], ["timeout", false, "timeout", ""],
  ["runtime_error", true, "failed", ""],
] as const)("projects %s with closed=%s as %s", (status, closed, kind, content) => {
  expect(displayTerminal({ type: "RUN_FINISHED", result: { status, externalEffectsMayContinue: status !== "success" } })).toEqual({ stage: { kind }, status });
  expect(finishDisplayAnswer(" answer ", status, closed)).toEqual({ committed: content !== "", content });
});
it("normalizes public errors without exposing raw exception text", () => {
  expect(displayTerminal({ type: "RUN_ERROR", code: "E_CONTEXT_FAILURE", message: "private detail" }))
    .toEqual({stage:{kind:"failed"},failure:{code:"E_CONTEXT_FAILURE",source:"context"}});
});
it.each([["failed", "error"], ["completed", "success"]] as const)("keeps tool identity across deltas and %s result", (status, expected) => {
  let state: NonNullable<ReturnType<typeof reduceToolDisplay>> = {records:[],nextSeq:9};
  for (const event of [
    {type:"TOOL_CALL_START",toolCallName:"lookup"}, {type:"TOOL_CALL_ARGS",delta:"a"}, {type:"TOOL_CALL_ARGS",delta:"b"},
    {type:"TOOL_CALL_RESULT",status,content:"r".repeat(4010)}, {type:"TOOL_CALL_END"},
  ] satisfies AguiEvent[]) state=reduceToolDisplay(state.records,{...event,toolCallId:"call"},"round",state.nextSeq,"Tool")!;
  expect(state).toEqual({nextSeq:10,records:[{ id:"call",name:"lookup",displayName:undefined,status:expected,result:"r".repeat(4000),argsText:"ab",changes:undefined,roundId:"round",seq:9,taskResult:undefined }]});
});
it("keeps a newer round active when the older round ends", () => {
  const first=applyAgentRoundBoundary({rounds:[]},"start","a",1);
  const next=applyAgentRoundBoundary(first,"start","b",2);
  expect(applyAgentRoundBoundary(next,"end","a",3)).toEqual({activeRoundId:"b",rounds:[
    {id:"a",status:"completed",startedAt:1,completedAt:3},{id:"b",status:"running",startedAt:2}
  ]});
});

it("accumulates formal text and commits it only after its closing event", () => {
  const initial = {text:"",closed:false};
  const begun = reduceDisplayAnswer(initial,{type:"TEXT_MESSAGE_START"});
  const first = reduceDisplayAnswer(begun,{type:"TEXT_MESSAGE_CONTENT",delta:"合"});
  const text = reduceDisplayAnswer(first,{type:"TEXT_MESSAGE_CONTENT",delta:"作"});
  expect(finishDisplayAnswer(text.text,"success",text.closed)).toEqual({committed:false,content:""});
  const closed = reduceDisplayAnswer(text,{type:"TEXT_MESSAGE_END"});
  expect(finishDisplayAnswer(closed.text,"success",closed.closed)).toEqual({committed:true,content:"合作"});
});
