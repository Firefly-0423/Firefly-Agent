/** Test-only ownership of opens, including those still pending when Vitest times out. */
export function createTestResourceScope<T>(release:(resource:T)=>Promise<void>){
 let stopping=false,closed:Promise<void>|undefined;
 const pending=new Set<Promise<T>>(),resources=new Set<T>(),releaseFailures:unknown[]=[];
 return {
  open(start:()=>Promise<T>):Promise<T>{
   if(stopping)return Promise.reject(new Error("TEST_SCOPE_CLOSED"));
   const operation=(async()=>{
    const resource=await start();
    if(stopping){try{await release(resource)}catch(error){releaseFailures.push(error);throw error}throw new Error("TEST_SCOPE_CLOSED")}
    resources.add(resource);return resource;
   })();
   pending.add(operation);
   void operation.then(()=>pending.delete(operation),()=>pending.delete(operation));
   return operation;
  },
  close():Promise<void>{
   if(closed)return closed;
   stopping=true;
   closed=(async()=>{
    await Promise.allSettled([...pending]);
    const settled=await Promise.allSettled([...resources].map(release));resources.clear();
    const failed=settled.find(result=>result.status==="rejected");
    if(failed?.status==="rejected")releaseFailures.push(failed.reason);
    if(releaseFailures.length)throw releaseFailures[0];
   })();
   return closed;
  }
 };
}
