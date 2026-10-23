import {it,expect} from "vitest";
import {createTestResourceScope} from "../../../scripts/verify/memory-core/test-resources";
it("waits for an in-flight open and closes its late handle before teardown resolves",async()=>{
 const scope=createTestResourceScope<{close():Promise<void>}>(r=>r.close());
 let ready!:(r:{close():Promise<void>})=>void;
 const events:string[]=[];
 const opening=scope.open(()=>new Promise(resolve=>{ready=resolve})).catch(e=>e.message);
 let completed=false;const cleanup=scope.close().then(()=>{completed=true;events.push("cleanup")});
 await Promise.resolve();await Promise.resolve();
 const premature=completed;
 ready({close:async()=>{events.push("handle-close")}});
 const result=await opening;await cleanup;
 expect(premature).toBe(false);
 expect(result).toBe("TEST_SCOPE_CLOSED");
 expect(events).toEqual(["handle-close","cleanup"]);
 let invoked=false;
 await expect(scope.open(async()=>{invoked=true;return{close:async()=>{}}})).rejects.toThrow("TEST_SCOPE_CLOSED");
 expect(invoked).toBe(false);
});
it("settles failed pending initialization before cleanup without an unhandled rejection",async()=>{
 const scope=createTestResourceScope<{close():Promise<void>}>(r=>r.close());
 let fail!:(e:Error)=>void;
 const opening=scope.open(()=>new Promise((_,reject)=>{fail=reject})).catch(e=>e.message);
 const cleanup=scope.close();fail(new Error("EXPECTED_OPEN_FAILURE"));
 expect(await opening).toBe("EXPECTED_OPEN_FAILURE");await cleanup;
});

it("reports a late handle release failure instead of authorizing fixture removal",async()=>{
 const scope=createTestResourceScope<{close():Promise<void>}>(r=>r.close());
 let ready!:(r:{close():Promise<void>})=>void;
 const opening=scope.open(()=>new Promise(resolve=>{ready=resolve})).catch(e=>e.message);
 const cleanup=scope.close();
 ready({close:async()=>{throw new Error("EXPECTED_RELEASE_FAILURE")}});
 expect(await opening).toBe("EXPECTED_RELEASE_FAILURE");
 await expect(cleanup).rejects.toThrow("EXPECTED_RELEASE_FAILURE");
});
