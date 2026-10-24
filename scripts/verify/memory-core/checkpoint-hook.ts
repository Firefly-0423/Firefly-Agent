import fs from "node:fs";
import path from "node:path";
/** Diagnostic bundle only. No production module imports this hook. */
export function installCheckpoint(root:string,pause:string|undefined,runId:string){
 (globalThis as any).__memoryProbeStage=(stage:string)=>{
  if(stage!==pause)return;
  fs.writeFileSync(path.join(root,"checkpoint-"+runId+".json"),JSON.stringify({stage,runId}));
  fs.writeSync(1,"MEMORY_CHECKPOINT "+JSON.stringify({stage,runId})+"\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
 };
}
