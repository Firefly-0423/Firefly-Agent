import {installCheckpoint} from "./checkpoint-hook";
import {isProbeWorkspace} from "./probe-root";
import fs from "node:fs";
import path from "node:path";
import {workerData,threadId} from "node:worker_threads";
import {within,canonicalPath} from "../../../src/main/base/identity/runtime-profile";
const cwd=process.cwd();
if(!isProbeWorkspace(cwd)||!within(path.join(cwd,"output","memory-core"),canonicalPath(workerData.probeReport)))throw new Error("PROBE_WORKER_ROOT_INVALID");
fs.writeFileSync(workerData.probeReport,JSON.stringify({electron:process.versions.electron,node:process.versions.node,sqlite:process.versions.sqlite,uv:process.versions.uv,threadId}));
installCheckpoint(path.dirname(workerData.probeReport),workerData.probePause,workerData.probeRunId);
try{require("../../../src/main/memory/database/worker")}catch(error){
 const code=error instanceof Error&&/^MEMORY_[A-Z_]+$/.test(error.message)?error.message:"PROBE_UNCLASSIFIED_INIT_ERROR";
 fs.writeFileSync(path.join(path.dirname(workerData.probeReport),"worker-init-"+workerData.probeRunId+".json"),JSON.stringify({runId:workerData.probeRunId,error:code}));throw error;
}
