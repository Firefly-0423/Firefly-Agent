import type {SourceIdentity,SourceRole,SourceTrust,SourceObservation} from "../memory-core/source-contracts";
import {parseInternalId} from "../memory-core/command-validation";

export interface SourceSnapshot extends SourceIdentity {
 contentRevision:number;generation:string;state:"live"|"deleted";
 role:SourceRole;trust:SourceTrust;text:string;occurredAt?:number;
}
export interface MainSourceProvider {
 providerId:string;
 authorize(scopeKey:string,identity:SourceIdentity):boolean;
 /** The adapter serializes controlled mutations until the operation completes. */
 withLease<T>(identity:SourceIdentity,operation:(read:()=>Promise<SourceSnapshot>)=>Promise<T>,previous?:Readonly<SourceObservation>):Promise<T>;
}
const providers=new WeakMap<object,MainSourceProvider>();
/** Main-only registration; DTOs cannot reconstruct this capability. */
export function createMainSourceProvider(provider:MainSourceProvider):object {
 parseInternalId(provider.providerId);
 if(typeof provider.authorize!=="function"||typeof provider.withLease!=="function")throw new Error("MEMORY_SOURCE_PROVIDER_DENIED");
 const token=Object.freeze({});
 providers.set(token,Object.freeze({providerId:provider.providerId,authorize:provider.authorize.bind(provider),withLease:provider.withLease.bind(provider)}));
 return token;
}
export function requireMainSourceProvider(token:unknown,scope:string,identity:SourceIdentity):MainSourceProvider {
 const provider=token&&typeof token==="object"?providers.get(token):undefined;
 if(!provider||provider.providerId!==identity.providerId||provider.authorize(scope,identity)!==true)throw new Error("MEMORY_SOURCE_PROVIDER_DENIED");
 return provider;
}
