import { describe, it, expect } from "vitest";
import { RunDisplayAccumulator } from "./run-display-accumulator";
describe("Main final display", () => {
  it("includes tools, rounds and post-terminal extras without losing the filtered answer", () => {
    const view = new RunDisplayAccumulator({id:"a",role:"model",content:"",at:10},"r");
    for (const event of [
      {type:"CUSTOM",name:"firefly.round",value:{action:"start",roundId:"round"}},
      {type:"TOOL_CALL_START",toolCallId:"tool",toolCallName:"read_file"},
      {type:"TOOL_CALL_RESULT",toolCallId:"tool",content:"evidence"},
      {type:"TEXT_MESSAGE_CONTENT",delta:" final answer "}, {type:"TEXT_MESSAGE_END"},
      {type:"RUN_FINISHED",result:{status:"success",externalEffectsMayContinue:false}},
      {type:"CUSTOM",name:"firefly.sticker",value:"happy"},
    ]) view.accept(event as never,20);
    const message = view.freeze({status:"success",externalEffectsMayContinue:false},30);
    expect(message.content).toBe("final answer");
    expect(message.sticker).toBe("happy");
    expect(message.toolExecutions).toEqual([{id:"tool",name:"read_file",displayName:undefined,status:"success",result:"evidence",argsText:undefined,changes:undefined,roundId:"round",seq:0,taskResult:undefined}]);
    expect(message.runSnapshot).toEqual({runId:"r",status:"terminal",terminalStatus:"success",updatedAt:30});
    view.accept({type:"TEXT_MESSAGE_CONTENT",delta:"late"},40);
    expect(view.freeze({status:"success",externalEffectsMayContinue:false},50)).toEqual(message);
  });
  it.each(["cancelled","timeout","runtime_error"] as const)("keeps partial text as interrupted progress for %s", status => {
    const view = new RunDisplayAccumulator({id:"a",role:"model",content:"",at:10},"r");
    view.accept({type:"CUSTOM",name:"firefly.round",value:{action:"start",roundId:"one"}},11);
    view.accept({type:"CUSTOM",name:"firefly.candidate_text",value:{roundId:"one",action:"delta",delta:"partial"}},12);
    view.accept({type:"RUN_ERROR",message:"secret-provider-token",code:"E_HARNESS_FAILURE"},13);
    const message = view.freeze({status,externalEffectsMayContinue:false},14);
    expect(message.content).toBe("");
    expect(message.processMessages).toEqual([{id:"process-0",content:"partial",interrupted:true,afterToolCount:0,roundId:"one",seq:0},{id:"process-1",content:"E_HARNESS_FAILURE",afterToolCount:0,roundId:"one",seq:1}]);
    expect(JSON.stringify(message)).not.toContain("secret-provider-token");
  });
});


it("closes running rounds and preserves filtered body received before an error",()=>{
 const view=new RunDisplayAccumulator({id:"a",role:"model",content:"",at:1},"r");
 view.accept({type:"RUN_STARTED"},1);
 view.accept({type:"CUSTOM",name:"firefly.round",value:{action:"start",roundId:"one"}},2);
 view.accept({type:"TEXT_MESSAGE_CONTENT",delta:"visible partial"},3);
 const final=view.freeze({status:"runtime_error",externalEffectsMayContinue:false},4);
 expect(final.content).toBe("");
 expect(final.processMessages).toEqual([{id:"process-0",content:"visible partial",interrupted:true,afterToolCount:0,roundId:"one",seq:0}]);
 expect(final.agentRounds).toEqual([{id:"one",status:"completed",startedAt:2,completedAt:4}]);
 expect(final.runActivity).toEqual({startedAt:1,reasoningMs:0,completedAt:4,activeReasoningStartedAt:undefined,keepExpanded:true});
});

it.each([
 ["same text", "the answer", "the answer"],
 ["answer grew past the candidate", "the ans", "the answer"],
])("a failed run keeps one interrupted copy when the candidate and the final answer carry the %s", (_case, candidate, answer) => {
 const view=new RunDisplayAccumulator({id:"a",role:"model",content:"",at:1},"r");
 view.accept({type:"CUSTOM",name:"firefly.round",value:{action:"start",roundId:"one"}},2);
 view.accept({type:"CUSTOM",name:"firefly.candidate_text",value:{roundId:"one",action:"delta",delta:candidate}},3);
 view.accept({type:"TEXT_MESSAGE_CONTENT",delta:answer},4);
 view.accept({type:"RUN_ERROR",code:"E_HARNESS_FAILURE",message:"checkpoint write failed"},5);
 const final=view.freeze({status:"runtime_error",externalEffectsMayContinue:false},6);
 expect(final.content).toBe("");
 expect(final.processMessages?.filter(entry=>entry.interrupted).map(entry=>entry.content)).toEqual([answer]);
 expect(final.processMessages?.map(entry=>entry.content)).toEqual([answer,"E_HARNESS_FAILURE"]);
});
