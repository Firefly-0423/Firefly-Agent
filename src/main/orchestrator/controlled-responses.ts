import type {TranscriptSink} from "./transcript-sink";
import {SRunSettlementGate} from "./run-settlement";
import type {AgentLoopEvent,AgentLoopResult,FireflyRunOptions} from "./firefly-agent";

/** Private Main callback contract; never a renderer DTO or a model request override. */
export interface ControlledStreamTarget {
 conversationId:string;runId:string;userTurnId:string;assistantTurnId:string;
 sink:TranscriptSink;onEvent:(event:AgentLoopEvent)=>void;isCurrent:()=>boolean;
}
export type ControlledResponsesRun=(options:FireflyRunOptions,signal:AbortSignal,onEvent:(event:AgentLoopEvent)=>void)=>Promise<AgentLoopResult>;
const settlements=new WeakMap<TranscriptSink,SRunSettlementGate>();
/** Shared only by the Main runtime and bridge for this actual bound sink. */
export function controlledSettlement(sink:TranscriptSink):SRunSettlementGate {
 let gate=settlements.get(sink);if(!gate){gate=new SRunSettlementGate();settlements.set(sink,gate)}return gate;
}
export function copyControlledStreamTarget(value:ControlledStreamTarget):ControlledStreamTarget {
 const fail=():never=>{throw Error("MEMORY_CONTEXT_STREAM_TARGET_INVALID")};
 if(!value||Object.getPrototypeOf(value)!==Object.prototype)fail();
 const fields=Object.getOwnPropertyDescriptors(value),allowed=["conversationId","runId","userTurnId","assistantTurnId","sink","onEvent","isCurrent"];
 if(Reflect.ownKeys(fields).some(key=>typeof key!=="string"||!allowed.includes(key))||Object.values(fields).some(field=>!("value" in field)))fail();
 const data=Object.fromEntries(Object.entries(fields).map(([key,field])=>[key,field.value]));
 for(const key of allowed.slice(0,4))if(typeof data[key]!=="string"||!data[key]||data[key].length>256||/[\u0000-\u001f\u007f]/.test(data[key]))fail();
 if(!data.sink||typeof data.sink!=="object"||typeof data.onEvent!=="function"||typeof data.isCurrent!=="function")fail();
 return Object.freeze(data) as unknown as ControlledStreamTarget;
}
