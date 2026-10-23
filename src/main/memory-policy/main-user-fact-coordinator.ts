import type {BoundSourceRef} from "../../shared/memory-contracts";
import {parseSourceRef} from "../memory-core/command-validation";
import {requireMainAccess} from "../memory-core/main-access";
import type {MainActorAuthority} from "../memory-core/main-actor-authority";
import type {createMainSourceRegistry} from "../memory-sources/source-registry";
import type {createMainPolicy} from "./main-policy";
import type {IntegrationResult} from "./policy-contracts";

/** Current authenticated user ingress only; historical fact supports use their own worker audit. */
export function requireCommittedUserSource(authority:MainActorAuthority,token:object,value:BoundSourceRef,temporaryError:string) {
 const actor=authority.requireActor(token);
 if(actor.sessionMode==="temporary")throw new Error(temporaryError);
 const sourceRef=parseSourceRef(value);
 if(!sourceRef.binding||sourceRef.binding.providerId!==actor.providerId||sourceRef.binding.sessionId!==actor.sessionId)throw new Error("MEMORY_ACTOR_DENIED");
 if(sourceRef.span)throw new Error("MEMORY_POLICY_FULL_SOURCE_REQUIRED");
 const source=requireMainAccess(actor.access).verifySource(sourceRef);
 if(source.kind!=="user"||source.sourceTrust!=="direct-user-event")throw new Error("MEMORY_USER_SOURCE_DENIED");
 return {actor,sourceRef:sourceRef as BoundSourceRef};
}

/** Main-only, uninstalled coordinator. No assistant input, model proposals or confirmation authority. */
export function createMainUserFactCoordinator(options:{actorAuthority:MainActorAuthority;registry:ReturnType<typeof createMainSourceRegistry>;policy:ReturnType<typeof createMainPolicy>}){
 return {
  async onCommittedUserSource(actorToken:object,boundSourceRef:BoundSourceRef,signal?:AbortSignal):Promise<IntegrationResult>{
   if(signal?.aborted)throw new Error("MEMORY_POLICY_CANCELLED");
   const {sourceRef}=requireCommittedUserSource(options.actorAuthority,actorToken,boundSourceRef,"MEMORY_POLICY_TEMPORARY_UNSUPPORTED");
   return options.policy.integrate(actorToken,sourceRef,signal);
  }
 };
}