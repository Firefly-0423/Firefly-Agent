/** Main-only one-shot experiment. All test dependencies are synthetic; no renderer IPC. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SessionProfile } from "./session-profile";
import { ATTEMPT_RESERVE_NANO_USD, BODY_SHA256, BUDGET_NANO_USD, buildFixedRequest, EXPERIMENT_ID, MODEL, ENDPOINT, inspectUsage, TOTAL_RESERVE_NANO_USD, type NumericUsage } from "./boundary";
import { safeFailure, type FailureCode, type SafeFailure } from "./diagnostics";
export const ADMISSION_ROOT = "E:\\Codex\\2026-10-01\\task\\memory-openrouter-usd1-admission-20261002";
const MAX_RESPONSE_BYTES = 65536;
const DEADLINE_MS = 30000;
const MAX_PRICE_AGE_MS = 24*60*60*1000;
export interface ProbeReceipt {
  status: "completed"|"refused"|"uncertain"|"cancelled";
  attempts: number;
  reservedNanoUsd: number;
  upperNanoUsd: number;
  usage: NumericUsage[];
  costNanoUsd:number|null;
  costStatus:"complete"|"partial"|"unknown";
  failure?:SafeFailure;
}
export interface ProbeRunnerDependencies {
  /** Injectable only for Main tests; composition root always binds fixed ADMISSION_ROOT. */
  root: string;
  resolveProfile(id:string): SessionProfile|undefined;
  fetch: typeof globalThis.fetch;
  now(): number;
}
interface Attempt { status:"pending"|"settled"; usage?: NumericUsage; }
interface Journal { experimentId:string; bodySha256:string; budgetNanoUsd:number; reservedNanoUsd:number; attempts:Attempt[]; receipt?:ProbeReceipt; }
function empty(status:ProbeReceipt["status"],failure=safeFailure(status==="cancelled"?"CANCELLED":"ADMISSION_REFUSED")):ProbeReceipt {return {status,attempts:0,reservedNanoUsd:0,upperNanoUsd:0,costNanoUsd:null,costStatus:"unknown",usage:[],failure};}
function validArm(raw:unknown,now:number):boolean {
  if (!raw || typeof raw!=="object") return false;
  const a=raw as Record<string,unknown>;
  return a.armed===true && a.experimentId===EXPERIMENT_ID && a.priorAttempts===0
    && a.budgetNanoUsd===BUDGET_NANO_USD && a.inputNanoUsdPerToken===300 && a.outputNanoUsdPerToken===1200
    && a.currency==="USD" && a.model===MODEL && a.endpoint===ENDPOINT && a.provider==="deepseek" && a.maxAttempts===2 && a.bodySha256===BODY_SHA256
    && typeof a.priceVerifiedAt==="number" && Number.isSafeInteger(a.priceVerifiedAt)
    && typeof a.expiresAt==="number" && Number.isSafeInteger(a.expiresAt)
    && now>=a.priceVerifiedAt && now-a.priceVerifiedAt<=MAX_PRICE_AGE_MS
    && a.expiresAt>now && a.expiresAt<=a.priceVerifiedAt+MAX_PRICE_AGE_MS;
}
function exclusiveSynced(file:string,content:string):void {
  const fd=fs.openSync(file,"wx",0o600);
  try {fs.writeFileSync(fd,content);fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
}
interface BootPermit { nonce:string; arm:unknown; }
function readArm(root:string):unknown {
  if (!path.isAbsolute(root)) throw new Error("ADMISSION_REFUSED");
  const info=fs.lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("ADMISSION_REFUSED");
  const file=path.join(root,"arm.json"), armInfo=fs.lstatSync(file);
  if (!armInfo.isFile() || armInfo.isSymbolicLink() || armInfo.size>4096) throw new Error("ADMISSION_REFUSED");
  return JSON.parse(fs.readFileSync(file,"utf8"));
}
/** Startup binds an existing non-secret arm to one boot; no profile or network access. */
function bindBoot(root:string,now:number):BootPermit|undefined {
  try {
    if (fs.existsSync(path.join(root,"spent.json")) || fs.existsSync(path.join(root,"ledger.json"))) return undefined;
    const arm=readArm(root);
    if (!validArm(arm,now)) return undefined;
    const nonce=randomUUID();
    exclusiveSynced(path.join(root,"boot.json"),JSON.stringify({experimentId:EXPERIMENT_ID,nonce}));
    return {nonce,arm};
  } catch {return undefined;}
}
/** Markers never removed. Missing/corrupt state cannot acquire a fresh budget. */
function claim(root:string,now:number,permit:BootPermit):void {
  if (fs.existsSync(path.join(root,"ledger.json"))) throw new Error("ADMISSION_REFUSED");
  const boot=JSON.parse(fs.readFileSync(path.join(root,"boot.json"),"utf8"));
  const arm=readArm(root);
  if (boot.experimentId!==EXPERIMENT_ID || boot.nonce!==permit.nonce
    || !validArm(permit.arm,now) || JSON.stringify(arm)!==JSON.stringify(permit.arm)) throw new Error("ADMISSION_REFUSED");
  exclusiveSynced(path.join(root,"spent.json"),JSON.stringify({experimentId:EXPERIMENT_ID,reservedNanoUsd:TOTAL_RESERVE_NANO_USD}));
  fs.unlinkSync(path.join(root,"arm.json"));
}
function cancelBody(response:Response):void {
  try {void response.body?.cancel().catch(()=>{});} catch { /* transport abort is the other bound */ }
}
async function limitedJson(response:Response,signal:AbortSignal,mark:(code:FailureCode)=>void):Promise<unknown> {
  if (!response.ok) {mark("HTTP_REJECTED");cancelBody(response);throw new Error("RESPONSE_REFUSED");}
  if (!response.body) {mark("BODY_MISSING");throw new Error("RESPONSE_REFUSED");}
  mark("BODY_READ_FAILED");
  const declared=response.headers.get("content-length");
  if (declared!==null && !/^\d+$/.test(declared)) {mark("BODY_LENGTH_INVALID");cancelBody(response);throw new Error("RESPONSE_REFUSED");}
  if (declared!==null && Number(declared)>MAX_RESPONSE_BYTES) {mark("BODY_TOO_LARGE");cancelBody(response);throw new Error("RESPONSE_REFUSED");}
  const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];
  const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener("abort",abort,{once:true});
  try {
    while (true) {
      if(signal.aborted)throw new Error("ABORTED");
      const chunk=await reader.read();if(signal.aborted)throw new Error("ABORTED");if(chunk.done)break;
      size+=chunk.value.byteLength;if(size>MAX_RESPONSE_BYTES){mark("BODY_TOO_LARGE");throw new Error("RESPONSE_REFUSED");}chunks.push(chunk.value);
    }
    mark("JSON_INVALID");
    return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks)));
  } finally {signal.removeEventListener("abort",abort);void reader.cancel().catch(()=>{});reader.releaseLock();}
}
export function createProbeRunner(deps:ProbeRunnerDependencies) {
  const permit=bindBoot(deps.root,deps.now());
  let inFlight:Promise<ProbeReceipt>|undefined, selectedId:string|undefined;
  let cancelled=false, active:AbortController|undefined;
  function cancel():void {cancelled=true;active?.abort();}
  async function execute(id:string):Promise<ProbeReceipt> {
    if(cancelled)return empty("cancelled");
    if(!permit)return empty("refused");
    let request:ReturnType<typeof buildFixedRequest>;
    let journal:Journal|undefined;
    let ledgerFd:number|undefined;
    let admitted=false;
    const usages:NumericUsage[]=[];
    let httpStatus:number|undefined,timedOut=false,lastFailure=safeFailure("INTERNAL_FAILURE");
    const mark=(code:FailureCode)=>{lastFailure=safeFailure(code,httpStatus);};
    function persist():void {
      if(ledgerFd===undefined || !journal)throw new Error("LEDGER_REFUSED");
      const bytes=Buffer.from(JSON.stringify(journal));
      // Same exclusively opened file; no rename/overwrite of another instance's ledger.
      try{fs.ftruncateSync(ledgerFd,0);fs.writeSync(ledgerFd,bytes,0,bytes.length,0);fs.fsyncSync(ledgerFd);}catch{mark("STORAGE_FAILED");throw new Error("LEDGER_REFUSED");}
    }
    function receipt(status:ProbeReceipt["status"],failure?:SafeFailure):ProbeReceipt {
      return {status,attempts:journal?.attempts.length ?? 0,reservedNanoUsd:TOTAL_RESERVE_NANO_USD,
        costNanoUsd:usages.length?usages.reduce((sum,u)=>sum+u.costNanoUsd,0):null,
        costStatus:usages.length?(usages.length===journal?.attempts.length?"complete":"partial"):"unknown",...(failure?{failure}:{}),
         upperNanoUsd:status==="completed"?usages.reduce((sum,u)=>sum+u.upperNanoUsd,0):TOTAL_RESERVE_NANO_USD,usage:usages.map(u=>({...u}))};
    }
    try {
      mark("PROFILE_REFUSED");const profile=deps.resolveProfile(id);if(!profile || profile.id!==id) return empty("refused",lastFailure);
      request=buildFixedRequest(profile);
      // Whole-experiment reservation, independent of profile or app instance. No rate-derived discount.
      if(TOTAL_RESERVE_NANO_USD>BUDGET_NANO_USD || ATTEMPT_RESERVE_NANO_USD*2>TOTAL_RESERVE_NANO_USD)return empty("refused");
      mark("ADMISSION_REFUSED");claim(deps.root,deps.now(),permit);admitted=true;
      mark("STORAGE_FAILED");
      ledgerFd=fs.openSync(path.join(deps.root,"ledger.json"),"wx",0o600);
      journal={experimentId:EXPERIMENT_ID,bodySha256:BODY_SHA256,budgetNanoUsd:BUDGET_NANO_USD,reservedNanoUsd:TOTAL_RESERVE_NANO_USD,attempts:[]};persist();
      for(let i=0;i<2;i++) {
        if(cancelled) {const result=receipt("cancelled",safeFailure("CANCELLED",httpStatus,lastFailure.stage));journal.receipt=result;persist();return result;}
        httpStatus=undefined;timedOut=false;mark("PERMIT_EXPIRED");if(!validArm(permit.arm,deps.now()))throw new Error("PERMIT_EXPIRED");
        journal.attempts.push({status:"pending"});persist(); // durable BEFORE entering fetch
        active=new AbortController();const controller=active;
        const timer=setTimeout(()=>{timedOut=true;controller.abort();},DEADLINE_MS);
        let onAbort:()=>void=()=>{};
        const aborted=new Promise<never>((_,reject)=>{
          onAbort=()=>reject(new Error("ABORTED"));controller.signal.addEventListener("abort",onAbort,{once:true});
        });
        try {
          const raw=await Promise.race([(async()=>{
            mark("PERMIT_EXPIRED");if(!validArm(permit.arm,deps.now()))throw new Error("PERMIT_EXPIRED");
            mark("NETWORK_FAILED");const response=await deps.fetch(request.url,{method:request.method,headers:request.headers,body:request.body,redirect:"error",signal:controller.signal});
            if(controller.signal.aborted){cancelBody(response);throw new Error("ABORTED");}
            httpStatus=typeof response.status==="number"&&Number.isInteger(response.status)&&response.status>=100&&response.status<=599?response.status:undefined;
            return limitedJson(response,controller.signal,mark);
          })(),aborted]);
          if(controller.signal.aborted || cancelled)throw new Error("ABORTED");
          const inspected=inspectUsage(raw);if("failure" in inspected){mark(inspected.failure.code);throw new Error("USAGE_REFUSED");}
          const usage=inspected.usage;usages.push(usage);journal.attempts[i]={status:"settled",usage};persist();
        } finally {clearTimeout(timer);controller.signal.removeEventListener("abort",onAbort);controller.abort();active=undefined;}
      }
      const result=receipt("completed");journal.receipt=result;persist();return result;
    } catch {
      // Never log exception/provider content or release ambiguous reservations.
      const failure=cancelled?safeFailure("CANCELLED",httpStatus,lastFailure.stage):timedOut?safeFailure("DEADLINE_EXCEEDED",httpStatus,lastFailure.stage):lastFailure;
      if (!admitted)return empty(cancelled?"cancelled":"refused",failure);
      const result=journal?receipt(cancelled?"cancelled":"uncertain",failure):{...empty(cancelled?"cancelled":"uncertain",failure),reservedNanoUsd:TOTAL_RESERVE_NANO_USD,upperNanoUsd:TOTAL_RESERVE_NANO_USD};
      try {if(journal){journal.receipt=result;persist();}} catch {/* spent claim remains; no resume */}
      return result;
    } finally {if(ledgerFd!==undefined){try{fs.closeSync(ledgerFd);}catch{/* no raw filesystem errors */}}}
  }
  return {
    start(id:string):Promise<ProbeReceipt> {
      if(inFlight)return id===selectedId?inFlight:Promise.resolve(empty("refused"));
      selectedId=id;inFlight=execute(id);return inFlight;
    }, cancel,
  };
}
