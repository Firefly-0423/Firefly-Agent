import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {Worker} from "node:worker_threads";
import {randomBytes,randomUUID} from "node:crypto";
import {build} from "esbuild";
import {beforeAll,afterAll,it,expect} from "vitest";
import {resolveRuntimeProfile} from "../runtime-profile";
import {createStorageContext} from "../storage-context";
import {MemoryClient} from "../memory-core/worker-client";
import {sealPayload,openPayload} from "../memory-core/payload-codec";
import {createOpenRouterExpense} from "./openrouter-bounded";
const root=fs.mkdtempSync(path.join(os.tmpdir(),"firefly-bounded-worker-")),workerPath=path.join(root,"worker.cjs"),wrapping=randomBytes(32);let worker:MemoryClient|undefined;
beforeAll(async()=>{if(process.platform==="win32")await build({entryPoints:["src/main/memory-core/worker.ts"],outfile:workerPath,bundle:true,platform:"node",target:"node24",format:"cjs"})});
afterAll(async()=>{try{await worker?.close()}finally{wrapping.fill(0);fs.rmSync(root,{recursive:true,force:true})}});
// The real MemoryClient requires Windows ownership and protected-key leases.
it.runIf(process.platform==="win32")("one real Worker persists a pending funding permit across close/reopen and denies generic access",async()=>{
 const isolation=path.join(root,"isolated"),production=path.join(root,"synthetic-production");fs.mkdirSync(isolation);fs.mkdirSync(production);
 const storage=createStorageContext(resolveRuntimeProfile({argv:["--firefly-profile=test","--firefly-isolation-root="+isolation],env:{},isPackaged:false,productionAppData:production})),binding={recordType:"synthetic-wrap",id:"bounded-worker",schemaVersion:1,keyVersion:1};
 const options={storage,keyProtection:{protect:async(value:Uint8Array)=>sealPayload(wrapping,binding,value),unprotect:async(value:Uint8Array)=>openPayload(wrapping,binding,value)},workerFactory:(data:any)=>new Worker(workerPath,{workerData:data,execArgv:[]})};
 worker=await MemoryClient.open(options);const transport={contextCommand:(c:unknown)=>worker!.contextCommand(c)},first=createOpenRouterExpense(transport,randomUUID()),token=await first.reserve();
 await expect(createOpenRouterExpense(transport,randomUUID()).reserve()).rejects.toThrow("MEMORY_CONTEXT_COST_UNCERTAIN");await worker.close();worker=await MemoryClient.open(options);
 await expect(createOpenRouterExpense(transport,randomUUID()).reserve()).rejects.toThrow("MEMORY_CONTEXT_COST_UNCERTAIN");
 await expect(worker.contextCommand({kind:"summaryGet",scopeKey:"desktop-openrouter-budget-v1",body:{actorKey:"desktop-local-user-v1",providerId:"openrouter-api-v1",sessionId:"openrouter-luna-budget-v1",bootId:randomUUID(),summaryId:"openrouter-luna-usd1-v1"}})).rejects.toThrow("MEMORY_CONTEXT_COST_DENIED");
 await first.settle(token,400000000);const next=createOpenRouterExpense(transport,randomUUID()),another=await next.reserve();await next.settle(another,400000000);await expect(createOpenRouterExpense(transport,randomUUID()).reserve()).rejects.toThrow("MEMORY_CONTEXT_COST_LIMIT");
});
