import assert from "node:assert/strict";
export function validateProbeResult(result,{runId,action,exit,pause,kill=false,marker=false,timedOut,expectedError}){
 assert.equal(timedOut,false,"probe exceeded its bounded execution time");
 assert.equal(result.runId,runId,"stale or foreign probe report");
 if(kill){
  assert.equal(marker,true,"owned kill had no matching checkpoint");
  assert.notEqual(exit.code,0,"checkpoint process was not killed");
  if(pause)assert.equal(result.stage,pause,"wrong initialization checkpoint");
  else{
   assert.equal(action,"hold");assert.equal(result.mode,"hold");
   assert.equal(result.ok,true);assert.equal(result.stage,"committed-live-wal");
  }
 }else{
  assert.equal(result.mode,action,"report belongs to a different action");
  assert.equal(exit.signal,null,"unexpected process signal");
  const rejecting=action==="reject"||action==="reject-payload";
  assert.equal(exit.code,rejecting?1:0,"unexpected process exit");
  assert.equal(result.ok,!rejecting,"unexpected probe outcome");
  if(rejecting){
   assert.match(expectedError,/^MEMORY_[A-Z_]+$/,"expected refusal must be scenario-specific");
   assert.equal(result.error==="MEMORY_WORKER_FAILED"?result.initializationError:result.error,expectedError,"wrong refusal reason");
  }
 }
 return result;
}

export function validateKeyResult({lines,exit,pause,marker,timedOut}){
 assert.equal(timedOut,false,"key probe timed out");
 if(pause){assert.equal(marker,true);assert.notEqual(exit.code,0);return}
 const result=lines.at(-1);assert.ok(result);assert.equal(exit.signal,null);
 if(result.ok===true)assert.equal(exit.code,0,"success was followed by cleanup failure");
 else{assert.equal(result.error,"MEMORY_KEY_FORMAT_UNSUPPORTED");assert.equal(exit.code,1)}
}
