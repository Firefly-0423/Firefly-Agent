import {requireMainAccess} from "./main-access";
import {randomUUID} from "node:crypto";
import {parseInternalId} from "./command-validation";
import {parseSourceIdentity} from "./source-ledger";
import type {SourceIdentity} from "./source-contracts";
import {requireMainSourceProvider} from "../memory-sources/main-source-provider";
export interface MainActorContext {access:object;adapter:object;scopeKey:string;actorKey:string;providerId:string;sessionId:string;sessionMode:"persistent"|"temporary";
 /** Live project binding of this session (a workspace key). Read at each use; undefined means global only. */
 project?:()=>string|undefined}
/** One Main-owned authority and mutation queue; no JSON capability or renderer export. */
export function createMainActorAuthority(options:{resolveActor:(scope:string,identity:SourceIdentity)=>string|null}) {
 const actors=new WeakMap<object,MainActorContext>();let queue:Promise<unknown>=Promise.resolve();
 const coordinate=<T>(operation:()=>Promise<T>|T):Promise<T>=>{const result=queue.then(operation);queue=result.catch(()=>undefined);return result};
 function requireActor(value:unknown):MainActorContext {const actor=value&&typeof value==="object"?actors.get(value):undefined;if(!actor)throw new Error("MEMORY_ACTOR_DENIED");return actor}
 function bindActor(access:object,adapter:object,value:SourceIdentity,settings:{sessionMode?:"persistent"|"temporary";project?:()=>string|undefined}={}):object {
  const scopeKey=requireMainAccess(access).scopeKey,identity=parseSourceIdentity(value);requireMainSourceProvider(adapter,scopeKey,identity);
  const actorKey=options.resolveActor(scopeKey,identity);if(typeof actorKey!=="string"||!actorKey)throw new Error("MEMORY_ACTOR_DENIED");parseInternalId(actorKey);
  const sessionMode=settings.sessionMode??"persistent";if(!["persistent","temporary"].includes(sessionMode))throw new Error("MEMORY_ACTOR_DENIED");
  const token=Object.freeze({});actors.set(token,Object.freeze({access,adapter,scopeKey,actorKey,providerId:identity.providerId,sessionId:identity.sessionId,sessionMode,...(settings.project?{project:settings.project}:{})}));return token;
 }
 return Object.freeze({coordinate,requireActor,bindActor,bootId:randomUUID()});
}
export type MainActorAuthority=ReturnType<typeof createMainActorAuthority>;
