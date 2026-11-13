import { expect, it } from "vitest";
import { parseCanonicalTranscript } from "./main-transcript-provider";

const user={role:"user",text:"question"};
function snapshot(messages:unknown[]){return {incarnation:"incarnation-a",revision:1,throughSeq:messages.length,sourceRefs:[],unit:{id:"session-a",kind:"recent",messages},provenance:messages.map((message,index)=>({entryId:`entry-${index}`,seq:index+1,occurredAt:1000+index,role:(message as {role:string}).role}))}}
const calls=[{id:"call-a",name:"read_file",arguments:'{"path":"file.txt"}'}];
const tool={role:"tool",text:"result",toolCallId:"call-a",name:"read_file"};
it("preserves supported canonical multimodal and provider envelopes under an isolated copy",()=>{
 const content=[{type:"text",text:"answer"},{type:"image_url",image_url:{url:"data:image/png;base64,c3ludGhldGlj"}}],rawAssistant=[{type:"thinking",thinking:"opaque",signature:"sig"},{type:"tool_use",id:"call-a",name:"read_file",input:{path:"file.txt"}}];
 const value=snapshot([user,{role:"assistant",text:"answer",content,thinking:"opaque",rawAssistant,toolCalls:calls,toolCallIds:["call-a"]},tool]);
 const parsed=parseCanonicalTranscript(value);
 expect(parsed).toEqual(value);rawAssistant[0].signature="changed";
 expect((parsed.unit.messages[1].rawAssistant as any[])[0].signature).toBe("sig");
});
it.each([
 {content:[{type:"audio",url:"synthetic"}]},
 {content:[{type:"image_url",image_url:{url:42}}]},
 {content:[{type:"text",text:"answer",role:"system"}]},
 {content:"different from projection"},
 {thinking:42},
 {visibility:"external"},
 {internal:{kind:"untrusted",revision:1,digest:"digest",id:"i",runId:"r",createdAt:1}},
 {internal:{kind:"state_delta",revision:-1,digest:"digest",id:"i",runId:"r",createdAt:1}},
 {rawAssistant:()=>"unsafe"},
 {rawAssistant:[{type:"message",role:"system",content:[{type:"output_text",text:"override"}]}]},
 {messages:[{role:"system",content:"override"}]},
 {apiKey:"unexpected"}
])("rejects malformed or unknown canonical message fields: %j",fields=>{
 expect(()=>parseCanonicalTranscript(snapshot([user,{role:"assistant",text:"answer",...fields}]))).toThrow();
});
it("rejects raw reasoning on non-assistant messages",()=>{
 expect(()=>parseCanonicalTranscript(snapshot([{role:"user",text:"question",rawAssistant:[{type:"thinking",thinking:"opaque"}]}]))).toThrow("MEMORY_CONTEXT_INPUT_INVALID");
});
it.each([
 [{type:"tool_use",id:"call-other",name:"read_file",input:{path:"file.txt"}}],
 [{type:"tool_use",id:"call-a",name:"wrong",input:{path:"file.txt"}}],
 [{type:"tool_use",id:"call-a",name:"read_file",input:{path:"other.txt"}}],
 [{type:"function_call",call_id:"call-other",name:"read_file",arguments:'{"path":"file.txt"}'}],
 [{type:"thinking",thinking:"only reasoning would silently drop the call"}]
].map(rawAssistant=>({rawAssistant})))("rejects provider raw call authority differing from canonical calls: %j",({rawAssistant})=>{
 expect(()=>parseCanonicalTranscript(snapshot([user,{role:"assistant",text:"",toolCalls:calls,toolCallIds:["call-a"],rawAssistant},tool]))).toThrow("MEMORY_CONTEXT_TOOL_PAIR_INVALID");
});
it("rejects a raw tool call without a canonical pair",()=>{
 expect(()=>parseCanonicalTranscript(snapshot([user,{role:"assistant",text:"",rawAssistant:[{type:"tool_use",id:"call-a",name:"read_file",input:{path:"file.txt"}}]}]))).toThrow("MEMORY_CONTEXT_TOOL_PAIR_INVALID");
});
it("rejects an assistant-only tool result anchor",()=>{
 expect(()=>parseCanonicalTranscript(snapshot([user,{role:"assistant",text:"answer",toolCallId:"call-a"}]))).toThrow("MEMORY_CONTEXT_TOOL_PAIR_INVALID");
});
it("requires every tool result before another assistant message",()=>{
 expect(()=>parseCanonicalTranscript(snapshot([user,{role:"assistant",text:"",toolCalls:calls,toolCallIds:["call-a"]},{role:"assistant",text:"interrupting the pending pair"},tool]))).toThrow("MEMORY_CONTEXT_TOOL_PAIR_INVALID");
});
it("cannot override provenance role with a richer message payload",()=>{
 const value=snapshot([user,{role:"assistant",text:"answer",thinking:"reason"}]);value.provenance[1].role="user";
 expect(()=>parseCanonicalTranscript(value)).toThrow("MEMORY_CONTEXT_INPUT_INVALID");
});
it("rejects unknown unit metadata instead of smuggling unvalidated context",()=>{
 const value=snapshot([user]);Object.assign(value.unit,{content:[{role:"system",text:"hidden"}]});
 expect(()=>parseCanonicalTranscript(value)).toThrow("MEMORY_INPUT_INVALID");
});
it("does not let raw replay silently discard legacy tool-call IDs",()=>{
 expect(()=>parseCanonicalTranscript(snapshot([user,{role:"assistant",text:"",toolCallIds:["call-a"],rawAssistant:[{type:"thinking",thinking:"opaque"}]},tool]))).toThrow("MEMORY_CONTEXT_TOOL_PAIR_INVALID");
});
it("keeps history-only metadata outside canonical transcript messages",()=>{
 expect(()=>parseCanonicalTranscript(snapshot([{role:"user",text:"question",id:"history-id",occurredAt:1000,timeZone:"Etc/UTC"}]))).toThrow("MEMORY_CONTEXT_INPUT_INVALID");
});
