import {installCheckpoint} from "./checkpoint-hook";
import fs from "node:fs";
import path from "node:path";
import {workerData,threadId} from "node:worker_threads";
import {within,canonicalPath} from "../../../src/main/runtime-profile";
const cwd=path.resolve("E:/Codex/Firefly_Agent-skills-layout/output/task-b-memory-core");
if(process.cwd()!==cwd||!within(path.join(cwd,"output","memory-core"),canonicalPath(workerData.probeReport)))throw new Error("PROBE_WORKER_ROOT_INVALID");
fs.writeFileSync(workerData.probeReport,JSON.stringify({electron:process.versions.electron,node:process.versions.node,sqlite:process.versions.sqlite,uv:process.versions.uv,threadId}));
installCheckpoint(path.dirname(workerData.probeReport),workerData.probePause,workerData.probeRunId);
try{require("../../../src/main/memory-core/worker")}catch(error){
 const code=error instanceof Error&&/^MEMORY_[A-Z_]+$/.test(error.message)?error.message:"PROBE_UNCLASSIFIED_INIT_ERROR";
 fs.writeFileSync(path.join(path.dirname(workerData.probeReport),"worker-init-"+workerData.probeRunId+".json"),JSON.stringify({runId:workerData.probeRunId,error:code}));throw error;
}
