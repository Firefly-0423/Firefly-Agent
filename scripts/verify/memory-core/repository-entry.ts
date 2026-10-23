import {installCheckpoint} from "./checkpoint-hook";
import fs from "node:fs";
import path from "node:path";
import {Worker} from "node:worker_threads";
import {app} from "electron";
import {resolveRuntimeProfile,applyElectronPaths,canonicalPath,within} from "../../../src/main/runtime-profile";
import {createStorageContext} from "../../../src/main/storage-context";
import {MemoryClient} from "../../../src/main/memory-core/worker-client";
import {createWindowsKeyProtection} from "../../../src/main/memory-core/windows-dpapi";
const cwd="E:\\Codex\\Firefly_Agent-skills-layout\\output\\task-b-memory-core";
if(process.cwd()!==cwd)throw new Error("PROBE_CWD_INVALID");
const argument=(name:string)=>process.argv.find(value=>value.startsWith(name+"="))?.slice(name.length+1);
const root=argument("--probe-root"),mode=argument("--probe-mode")??"basic";
if(!root||!within(path.join(cwd,"output","memory-core"),canonicalPath(root)))throw new Error("PROBE_ROOT_INVALID");
const pause=argument("--probe-pause"),runId=argument("--probe-run-id");
if(!runId||!/^[a-f0-9-]{36}$/.test(runId))throw new Error("PROBE_RUN_ID_INVALID");
installCheckpoint(root,pause,runId);
const resultPath=path.join(root,"result-"+runId+".json");
const report=(input:object)=>{const value={...input,mode,runId};fs.writeFileSync(resultPath,JSON.stringify(value,null,2));console.log("MEMORY_CORE_PROBE "+JSON.stringify(value))};
const production=path.join(root,"synthetic-production"),isolation=path.join(root,"isolated");
fs.mkdirSync(production,{recursive:true});fs.mkdirSync(isolation,{recursive:true});
const profile=resolveRuntimeProfile({argv:["--firefly-profile=test","--firefly-isolation-root="+isolation],env:{},isPackaged:app.isPackaged,productionAppData:production});
applyElectronPaths(app,profile);
app.setPath("temp",path.join(root,"temp"));
const storage=createStorageContext(profile);
const canary="FIREFLY_SYNTHETIC_\u4e2d\u6587_English_\u6df7\u5408_\ud83c\udf40_CANARY";
(async()=>{
 let client:MemoryClient|undefined;
 try{
  await app.whenReady();
  client=await MemoryClient.open({storage,keyProtection:createWindowsKeyProtection(storage.memory.tempRoot),workerFactory:data=>new Worker(path.join(__dirname,"worker.js"),{workerData:{...data,probeReport:path.join(root,"worker-runtime.json"),probePause:pause,probeRunId:runId},execArgv:[]})});
  if(mode==="jobs"){const {verifyJobs}=await import("./jobs-probe");const checks=await verifyJobs(client,canary);await client.close();client=undefined;report({ok:true,mode,...checks});app.exit(0);return}
  if(mode==="facts"){
   const {MemoryService}=await import("../../../src/main/memory-core/memory-service");
   const {createMainMemoryAuthority}=await import("../../../src/main/memory-core/main-access");
   const sources=new Map<string,import("../../../src/main/memory-core/main-access").VerifiedSource>();
   const ref={sourceId:"fact-source",revision:1};
   sources.set(ref.sourceId,{...ref,scopeKey:"scope-test",kind:"user",intent:"statement",policyEligibility:{directStatement:true,inferred:false,sensitive:false,conflict:false}});
   const authority=createMainMemoryAuthority({policyVersion:"policy-v1",resolveSource:r=>sources.get(r.sourceId)!}),access=authority.access("scope-test"),service=new MemoryService(client);
   await service.registerSource(access,"fact-register",ref);
   await service.appendEvidence(access,{commandId:"fact-evidence",evidenceId:"fact-evidence",sourceRef:ref,text:canary});
   await service.proposeCandidate(access,{commandId:"fact-propose",candidateId:"fact-candidate",evidenceId:"fact-evidence",fact:{subjectKey:"合成双语",assertion:canary,assertionKind:"user-statement",time:{validFrom:null,validTo:null,referenceTime:null}}});
   if((await service.current(access)).length!==0)throw new Error("PROBE_CANDIDATE_BECAME_ACTIVE");
   const token=authority.authorize(access,{candidateId:"fact-candidate",sourceRef:ref,reason:"policyAccepted"});
   const active=await service.activateCandidate(access,token,{commandId:"fact-activate",candidateId:"fact-candidate"});
   const correction={sourceId:"fact-correction",revision:1};
   sources.set(correction.sourceId,{...correction,scopeKey:"scope-test",kind:"user",intent:"correction",factId:active.id});
   await service.registerSource(access,"correction-register",correction);
   const outcomes=await Promise.allSettled([0,1].map(index=>service.correctFact(access,{commandId:"correct-"+index,factId:active.id,expectedRevision:1,sourceRef:correction,fact:{subjectKey:"合成双语",assertion:canary+" "+index,assertionKind:"user-statement",time:{validFrom:null,validTo:null,referenceTime:null}}})));
   if(outcomes.filter(value=>value.status==="fulfilled").length!==1||(outcomes.find(value=>value.status==="rejected") as PromiseRejectedResult).reason.message!=="MEMORY_REVISION_CONFLICT")throw new Error("PROBE_REVISION_CONFLICT_FAILED");
   const history=await service.history(access,active.id);
   if(history.length!==2||history[0].supersededAt===null||history[1].revision!==2)throw new Error("PROBE_REVISION_HISTORY_FAILED");
   if((await service.current(authority.access("scope-other"))).length!==0)throw new Error("PROBE_SCOPE_LEAK");
   const rollback={commandId:"rollback-constraint",scopeKey:"scope-test",records:[{table:"sources" as const,id:"rollback-source",revision:1,payload:{text:canary}},{table:"sources" as const,id:"rollback-source",revision:1,payload:{text:canary}}]};
   let rejected=false;try{await client.writeBatch(rollback)}catch{rejected=true}
   if(!rejected||(await client.readRows("sources","scope-test")).some(row=>row.id==="rollback-source"))throw new Error("PROBE_ROLLBACK_FAILED");
   await client.writeBatch({...rollback,records:rollback.records.slice(0,1)});
   const forgetting={sourceId:"fact-forget",revision:1};
   sources.set(forgetting.sourceId,{...forgetting,scopeKey:"scope-test",kind:"user",intent:"forget",factId:active.id});
   await service.registerSource(access,"forget-register",forgetting);
   await service.forgetFact(access,{commandId:"fact-forget",factId:active.id,expectedRevision:2,sourceRef:forgetting});
   if((await service.current(access)).length!==0)throw new Error("PROBE_FORGET_FAILED");
   let historyDenied=false;try{await service.history(access,active.id)}catch(error){historyDenied=error instanceof Error&&error.message==="MEMORY_FACT_NOT_FOUND"}
   if(!historyDenied)throw new Error("PROBE_FORGOTTEN_HISTORY_VISIBLE");
   const workerRuntime=JSON.parse(fs.readFileSync(path.join(root,"worker-runtime.json"),"utf8"));
   await client.close();client=undefined;
   report({ok:true,mode,workerRuntime,workerInAsar:__dirname.includes("app.asar"),candidateAuthorization:true,concurrentRevisionConflict:true,appendHistory:true,transactionRollback:true,scopeIsolation:true,forgetRecallBlocked:true,normalExit:true});
   app.exit(0);return;
  }

  if(mode==="reject"){throw new Error("PROBE_UNEXPECTED_KEY_ACCEPTANCE")}
  const command={commandId:"integration-seed",scopeKey:"scope-test",records:[{table:"sources" as const,id:"source-test",revision:1,payload:{text:canary,title:"合成来源不应明文"}}]};
  if(mode==="basic"||mode==="hold"){
   const concurrent=await Promise.all([client.writeBatch(command),client.writeBatch(command)]);
   if(concurrent.some(r=>r.inserted!==1))throw new Error("PROBE_IDEMPOTENCY_FAILED");
   await client.backup("consistent-snapshot");
  }
  const rows=await client.readRows("sources","scope-test");
  if(rows.length!==1||(rows[0].payload as {text:string}).text!==canary)throw new Error("PROBE_RECOVERY_FAILED");
  const workerRuntime=JSON.parse(fs.readFileSync(path.join(root,"worker-runtime.json"),"utf8"));
  const result={ok:true,workerRuntime,mode,count:rows.length,canaryMatch:true,workerInAsar:__dirname.includes("app.asar"),versions:{electron:process.versions.electron,node:process.versions.node,sqlite:process.versions.sqlite,uv:process.versions.uv},roots:storage.memory};
  if(mode==="hold"){report({...result,stage:"committed-live-wal"});await new Promise<void>(()=>{})}
  await client.close();client=undefined;report(result);app.exit(0);
 }catch(error){
  await client?.close().catch(()=>{});
  const initializationPath=path.join(root,"worker-init-"+runId+".json");
  const initialization=fs.existsSync(initializationPath)?JSON.parse(fs.readFileSync(initializationPath,"utf8")):undefined;
  const initializationError=initialization?.runId===runId&&/^MEMORY_[A-Z_]+$/.test(initialization.error)?initialization.error:undefined;
  report({ok:false,initializationError,error:error instanceof Error&&/^(MEMORY|PROBE)_[A-Z_]+$/.test(error.message)?error.message:"PROBE_FAILURE",frames:error instanceof Error?error.stack?.split("\n").filter(line=>/^\s+at /.test(line)).slice(0,3):[]});app.exit(1);
 }
})();
