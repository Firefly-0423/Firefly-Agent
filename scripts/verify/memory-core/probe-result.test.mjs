import {test} from "node:test";
import assert from "node:assert/strict";
import {validateProbeResult,validateKeyResult} from "./probe-result.mjs";
const expected={runId:"current-run",action:"read",exit:{code:0,signal:null},timedOut:false};
test("refuses stale same-root success from a previous run",()=>{
 assert.throws(()=>validateProbeResult({ok:true,runId:"previous-run",mode:"read"},expected));
});
test("refuses a success report followed by abnormal process exit",()=>{
 assert.throws(()=>validateProbeResult({ok:true,runId:"current-run",mode:"read"},{...expected,exit:{code:1,signal:null}}));
});
test("accepts only the matching expected rejection",()=>{
 const result={ok:false,runId:"current-run",mode:"reject",error:"MEMORY_KEY_UNAVAILABLE"};
 assert.equal(validateProbeResult(result,{...expected,action:"reject",exit:{code:1,signal:null},expectedError:"MEMORY_KEY_UNAVAILABLE"}),result);
});
test("refuses a timeout even if a valid result file was written",()=>{
 assert.throws(()=>validateProbeResult({ok:true,runId:"current-run",mode:"read"},{...expected,timedOut:true}));
});

test("accepts the current committed live-WAL hold after an owned process kill",()=>{
 const result={ok:true,mode:"hold",runId:"current-run",stage:"committed-live-wal"};
 assert.equal(validateProbeResult(result,{...expected,action:"hold",kill:true,marker:true,exit:{code:1,signal:null}}),result);
});
test("refuses a killed hold without its current success marker",()=>{
 assert.throws(()=>validateProbeResult({ok:true,mode:"hold",runId:"current-run",stage:"committed-live-wal"},{...expected,action:"hold",kill:true,marker:false,exit:{code:1,signal:null}}));
});

test("does not count an unrelated DPAPI failure as the expected missing-key rejection",()=>{
 assert.throws(()=>validateProbeResult({ok:false,mode:"reject",runId:"current-run",error:"MEMORY_DPAPI_FAILED"},{...expected,action:"reject",exit:{code:1,signal:null},expectedError:"MEMORY_KEY_UNAVAILABLE"}));
});

test("legacy key success cannot hide a later cleanup failure",()=>{
 assert.throws(()=>validateKeyResult({lines:[{ok:true}],exit:{code:1,signal:null},timedOut:false}));
});
test("legacy key success cannot hide a timeout",()=>{
 assert.throws(()=>validateKeyResult({lines:[{ok:true}],exit:{code:0,signal:null},timedOut:true}));
});
test("legacy key success requires a normal exit",()=>{
 assert.doesNotThrow(()=>validateKeyResult({lines:[{ok:true}],exit:{code:0,signal:null},timedOut:false}));
});
