import { expect, it, vi } from "vitest";
vi.mock("electron",()=>({app:{getPath:()=>""},shell:{openPath:vi.fn()}}));
import { canonicalTurnUnits } from "./conversation-transcript-adapter";
import type { TranscriptEntry } from "../orchestrator/conversation-transcript-types";

it.each([0,1])("materializes a fully masked gh-style tool result with exit code %s", exitCode=>{
 const stdout="github.com\n  - Active account: true\n  - Token: gho_"+"*".repeat(36)+"\n  - Token scopes: 'repo'\nFile not found\n";
 const call={id:"synthetic-call",name:"run_shell",arguments:'{"command":"synthetic_probe"}'};
 const entries:TranscriptEntry[]=[
  {id:"user",seq:1,at:1,kind:"user",turnId:"synthetic-user",revision:1,payload:{text:"Synthetic diagnostic"}},
  {id:"assistant",seq:2,at:2,kind:"assistant",runId:"synthetic-run",payload:{role:"assistant",content:"",toolCalls:[call]}},
  {id:"result",seq:3,at:3,kind:"tool_result",runId:"synthetic-run",payload:{assistantEntryId:"assistant",toolCallId:call.id,outcome:exitCode?"unknown":"success",message:{role:"tool",toolCallId:call.id,name:call.name,content:JSON.stringify({outcome:exitCode?"unknown":"success",output:JSON.stringify({success:!exitCode,exitCode,stdout,stderr:""})})}}},
 ];
 const result=canonicalTurnUnits({entries,throughSeq:3},"synthetic-session");
 expect(result.flatMap(unit=>unit.messages).map(message=>message.role)).toEqual(["user","assistant","tool"]);
});
