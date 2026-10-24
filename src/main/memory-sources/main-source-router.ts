import {parseInternalId} from "../memory-core/command-validation";
import type {SourceIdentity,SourceObservation} from "../memory-core/source-contracts";
import {parseSourceIdentity} from "../memory-core/source-ledger";
import {createMainSourceProvider,requireMainSourceProvider,type SourceSnapshot} from "./main-source-provider";

export interface MainSourceRouteRegistration {
 scopeKey:string;
 /** Main-owned identity used for authorization only; registration never reads its text. */
 anchorIdentity:SourceIdentity;
 sourceToken:object;
 lifetime?:AbortSignal;
}
interface Route {
 scopeKey:string;sessionId:string;sourceToken:object;lifetime?:AbortSignal;
 active:boolean;pending:Set<Promise<unknown>>;removeAbort?:()=>void;drained?:Promise<void>;
}
const denied=():never=>{throw Error("MEMORY_SOURCE_ROUTER_DENIED")};
const conflict=():never=>{throw Error("MEMORY_SOURCE_ROUTE_CONFLICT")};

/** Main-only routing capability shared by the storage owner's existing registry/authority.
 * Routes carry no source text or replacement provenance and retain each child's authorization.
 * Session IDs stay pinned to their scope even after unmount: authorize has a scope parameter,
 * but withLease does not, so permitting scope reassignment would create a confused deputy. */
export function createMainSourceRouter(options:{providerId:string}) {
 const providerId=parseInternalId(options.providerId),routes=new Map<string,Route>(),scopes=new Map<string,string>();
 const routeTokens=new WeakMap<object,Route>();
 let closed=false,closing:Promise<void>|undefined;

 function current(route:Route,id:SourceIdentity):void {
  if(closed||!route.active||route.lifetime?.aborted||routes.get(route.sessionId)!==route
   ||id.providerId!==providerId||id.sessionId!==route.sessionId)return denied();
 }
 function authorized(route:Route,id:SourceIdentity){
  current(route,id);
  const child=requireMainSourceProvider(route.sourceToken,route.scopeKey,id);
  // A child authorization callback may synchronously revoke its lifetime.
  current(route,id);return child;
 }
 function revoke(route:Route):Promise<void> {
  route.active=false;route.removeAbort?.();route.removeAbort=undefined;
  // No authority/source queue is held here. Rejection cannot poison draining, and an
  // aborted operation is still owned until the child's entire withLease has settled.
  return route.drained??(route.drained=Promise.allSettled([...route.pending]).then(()=>{
   if(routes.get(route.sessionId)===route)routes.delete(route.sessionId);
  }));
 }
 const token=createMainSourceProvider({providerId,
  authorize(scope,identity){
   try{
    const id=parseSourceIdentity(identity),route=routes.get(id.sessionId);
    if(!route||scope!==route.scopeKey)return false;
    authorized(route,id);return true;
   }catch{return false}
  },
  async withLease<T>(identity:SourceIdentity,operation:(read:()=>Promise<SourceSnapshot>)=>Promise<T>,previous?:Readonly<SourceObservation>):Promise<T>{
   const id=Object.freeze(parseSourceIdentity(identity)),route=routes.get(id.sessionId);
   if(!route)return denied();
   authorized(route,id);
   // Register before entering child code, including synchronous callbacks/revocations.
   // The route has its own in-flight set, not a second serialized global queue.
   const pending=Promise.resolve().then(async()=>{
    const child=authorized(route,id);let entered=false,leaseOpen=true;
    const validate=()=>{if(!leaseOpen)return denied();authorized(route,id)};
    try{
     const result=await child.withLease(id,async read=>{
      if(entered)return denied();entered=true;validate();
      let reading=true;
      try{
       const result=await operation(async()=>{
        if(!reading)return denied();validate();
        const value=await read();
        if(!reading)return denied();validate();
        return value;
       });
       validate();return result;
      }finally{reading=false}
     },previous);
     validate();return result;
    }finally{leaseOpen=false}
   });
   route.pending.add(pending);
   try{return await pending}finally{route.pending.delete(pending)}
  },
 });
 return Object.freeze({token,
  register(input:MainSourceRouteRegistration):object {
   if(closed)return denied();
   const scopeKey=parseInternalId(input.scopeKey),anchor=Object.freeze(parseSourceIdentity(input.anchorIdentity));
   const sourceToken=input.sourceToken,lifetime=input.lifetime;
   if(anchor.providerId!==providerId||(lifetime&&(!(lifetime instanceof AbortSignal)||lifetime.aborted)))return denied();
   if(routes.has(anchor.sessionId)||(scopes.has(anchor.sessionId)&&scopes.get(anchor.sessionId)!==scopeKey))return conflict();
   requireMainSourceProvider(sourceToken,scopeKey,anchor);
   // Authorization is external Main code; recheck lifecycle/conflicts after invoking it.
   if(closed||lifetime?.aborted)return denied();
   if(routes.has(anchor.sessionId)||(scopes.has(anchor.sessionId)&&scopes.get(anchor.sessionId)!==scopeKey))return conflict();
   const route:Route={scopeKey,sessionId:anchor.sessionId,sourceToken,lifetime,active:true,pending:new Set()};
   const routeToken=Object.freeze({});routeTokens.set(routeToken,route);scopes.set(anchor.sessionId,scopeKey);routes.set(anchor.sessionId,route);
   if(lifetime){
    const abort=()=>{void revoke(route)};
    lifetime.addEventListener("abort",abort,{once:true});route.removeAbort=()=>lifetime.removeEventListener("abort",abort);
   }
   return routeToken;
  },
  async unregister(routeToken:object):Promise<void> {
   const route=routeToken&&typeof routeToken==="object"?routeTokens.get(routeToken):undefined;
   if(!route)return denied();
   await revoke(route);
  },
  close():Promise<void> {
   if(closing)return closing;
   closed=true;
   closing=Promise.all([...routes.values()].map(revoke)).then(()=>undefined);return closing;
  },
 });
}
