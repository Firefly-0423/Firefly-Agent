import {objectFields,parseInternalId} from "../memory-core/command-validation";
import {canonicalJson} from "../memory-core/repository-types";
import {recallFail,type RecallPolicy,type StrengthState,type RecallProtection} from "./recall-contracts";
const DAY=86400000;
export const DEFAULT_RECALL_POLICY:Readonly<RecallPolicy>=Object.freeze({version:"recall-decay-v1",halfLifeMs:30*DAY,archiveThreshold:0.125,minIdleMs:90*DAY,protectExplicitConfirmation:true,maintenanceMode:"dry-run",batchSize:100});
function clock(value:unknown):number{if(!Number.isSafeInteger(value)||(value as number)<0)recallFail("MEMORY_RECALL_TIME_INVALID");return value as number}
export function validateRecallPolicy(value:unknown):Readonly<RecallPolicy>{
 const p=objectFields(value,["version","halfLifeMs","archiveThreshold","minIdleMs","protectExplicitConfirmation","maintenanceMode","batchSize"]);
 const integer=(n:unknown,min:number,max:number)=>Number.isSafeInteger(n)&&(n as number)>=min&&(n as number)<=max;
 if(typeof p.version!=="string"||!/^[-a-zA-Z0-9_]{1,96}$/.test(p.version)||!integer(p.halfLifeMs,DAY,3650*DAY)||typeof p.archiveThreshold!=="number"||!Number.isFinite(p.archiveThreshold)||p.archiveThreshold<=0||p.archiveThreshold>=1||!integer(p.minIdleMs,0,36500*DAY)||typeof p.protectExplicitConfirmation!=="boolean"||!["disabled","dry-run","enabled"].includes(p.maintenanceMode as string)||!integer(p.batchSize,1,200))recallFail("MEMORY_RECALL_POLICY_INVALID");
 return Object.freeze({version:parseInternalId(p.version),halfLifeMs:p.halfLifeMs as number,archiveThreshold:p.archiveThreshold,minIdleMs:p.minIdleMs as number,protectExplicitConfirmation:p.protectExplicitConfirmation,maintenanceMode:p.maintenanceMode as RecallPolicy["maintenanceMode"],batchSize:p.batchSize as number});
}
function checked(value:StrengthState,now:number):StrengthState{
 clock(now);const s=objectFields(value,["lastAccessAt","decayAnchorAt","lastCalculatedAt","strengthAtLastCalculation"]);
 const lastAccessAt=s.lastAccessAt===null?null:clock(s.lastAccessAt),decayAnchorAt=clock(s.decayAnchorAt),lastCalculatedAt=clock(s.lastCalculatedAt),strength=s.strengthAtLastCalculation;
 if(typeof strength!=="number"||!Number.isFinite(strength)||strength<0||strength>1)recallFail("MEMORY_RECALL_STATE_INVALID");
 if(lastCalculatedAt>now||decayAnchorAt>lastCalculatedAt||(lastAccessAt!==null&&(lastAccessAt>lastCalculatedAt||lastAccessAt>decayAnchorAt)))recallFail("MEMORY_RECALL_CLOCK_INVALID");
 return {lastAccessAt,decayAnchorAt,lastCalculatedAt,strengthAtLastCalculation:strength};
}
export function initializeStrength(now:number):StrengthState{clock(now);return {lastAccessAt:null,decayAnchorAt:now,lastCalculatedAt:now,strengthAtLastCalculation:1}}
export function calculateStrength(value:StrengthState,now:number,policy:RecallPolicy):StrengthState{
 const s=checked(value,now),p=validateRecallPolicy(policy);return {...s,lastCalculatedAt:now,strengthAtLastCalculation:s.strengthAtLastCalculation*2**(-(now-s.lastCalculatedAt)/p.halfLifeMs)};
}
export function refreshStrength(value:StrengthState,now:number):StrengthState{return {...checked(value,now),decayAnchorAt:now,lastCalculatedAt:now,strengthAtLastCalculation:1}}
export function recordAccess(value:StrengthState,now:number):StrengthState{return {...refreshStrength(value,now),lastAccessAt:now}}
export function transitionPolicy(value:StrengthState,now:number,oldPolicy:RecallPolicy,newPolicy:RecallPolicy):StrengthState{
 const previous=validateRecallPolicy(oldPolicy),next=validateRecallPolicy(newPolicy);if(previous.version===next.version&&canonicalJson(previous)!==canonicalJson(next))recallFail("MEMORY_RECALL_POLICY_CONFLICT");return calculateStrength(value,now,previous);
}
export function isArchiveCandidate(value:StrengthState,now:number,policy:RecallPolicy,protection:RecallProtection):boolean{
 const s=calculateStrength(value,now,policy),p=validateRecallPolicy(policy),flags=objectFields(protection,["pinned","explicitConfirmation","required"]);
 if(Object.values(flags).some(v=>typeof v!=="boolean"))recallFail("MEMORY_RECALL_STATE_INVALID");
 const protectedFact=flags.pinned||flags.required||(p.protectExplicitConfirmation&&flags.explicitConfirmation);
 // A tiny comparison tolerance covers repeated IEEE754 multiplication, not a policy band.
 const tolerance=16*Number.EPSILON*Math.max(1,p.archiveThreshold,s.strengthAtLastCalculation);
 return !protectedFact&&now-s.decayAnchorAt>=p.minIdleMs&&s.strengthAtLastCalculation<=p.archiveThreshold+tolerance;
}
