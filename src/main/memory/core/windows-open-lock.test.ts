import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {spawn} from "node:child_process";
import {afterEach,it,expect,vi} from "vitest";
import {acquireMemoryOpenLease,windowsHelperConfig} from "./windows-open-lock";
vi.mock("node:child_process",()=>({spawn:vi.fn()}));
// Lease lifecycle tests require the trusted Windows system installation even with a mocked child.
const dirs:string[]=[];
afterEach(()=>{vi.useRealTimers();vi.resetAllMocks();vi.unstubAllEnvs();for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true})});
function root(){const d=fs.mkdtempSync(path.join(os.tmpdir(),"memory-lock-"));dirs.push(d);return d}
function helper(){
 const c:any=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.stdin=new PassThrough();c.killed=false;
 c.kill=()=>{c.killed=true;c.emit("close",null);return true};
 c.stdin.once("data",()=>queueMicrotask(()=>c.stdout.write("MEMORY_LOCK_READY\n")));
 vi.mocked(spawn).mockReturnValue(c);return c;
}
it.runIf(process.platform==="win32")("does not expire a held lease after the startup deadline",async()=>{
 vi.useFakeTimers();const c=helper(),d=root();const pending=acquireMemoryOpenLease(d,d);
 await vi.advanceTimersByTimeAsync(0);const lease=await pending;
 try{await vi.advanceTimersByTimeAsync(10001);expect(c.killed).toBe(false);expect(()=>lease.assertHeld()).not.toThrow()}
 finally{c.emit("close",0);await lease.release().catch(()=>{})}
});
it.runIf(process.platform==="win32")("bounds release of an unresponsive helper and waits for close",async()=>{
 vi.useFakeTimers();const c=helper(),d=root();const pending=acquireMemoryOpenLease(d,d);
 await vi.advanceTimersByTimeAsync(0);const lease=await pending;
 let settled=false;const result=lease.release().then(()=>{settled=true;return null},error=>{settled=true;return error});
 await vi.advanceTimersByTimeAsync(10001);
 try{expect(settled).toBe(true);expect(c.killed).toBe(true);expect((await result)?.message).toBe("MEMORY_OPEN_LOCK_LOST")}
 finally{c.emit("close",0);await result}
});
it.runIf(process.platform==="win32")("rejects loss of the helper while the lease is in use",async()=>{
 const c=helper(),d=root(),lease=await acquireMemoryOpenLease(d,d);c.emit("close",1);
 expect(()=>lease.assertHeld()).toThrow("MEMORY_OPEN_LOCK_LOST");await lease.release().catch(()=>{});
});
it("rejects relative host SystemRoot before launching a helper",()=>{
 vi.stubEnv("SystemRoot","relative");expect(()=>windowsHelperConfig(root())).toThrow(process.platform==="win32"?"MEMORY_HELPER_PATH_INVALID":"MEMORY_WINDOWS_REQUIRED");expect(spawn).not.toHaveBeenCalled();
});
it("rejects an executable supplied outside the fixed Windows system installation",()=>{
 const d=root(),binary=path.join(d,"System32","WindowsPowerShell","v1.0","powershell.exe");
 fs.mkdirSync(path.dirname(binary),{recursive:true});fs.writeFileSync(binary,"synthetic");
 vi.stubEnv("SystemRoot",d);expect(()=>windowsHelperConfig(root())).toThrow(process.platform==="win32"?"MEMORY_HELPER_PATH_INVALID":"MEMORY_WINDOWS_REQUIRED");expect(spawn).not.toHaveBeenCalled();
});

it.runIf(process.platform==="win32")("makes concurrent release callers await the same bounded exit result",async()=>{
 vi.useFakeTimers();const c=helper(),d=root(),pending=acquireMemoryOpenLease(d,d);
 await vi.advanceTimersByTimeAsync(0);const lease=await pending;
 let secondSettled=false;
 const one=lease.release().then(()=>null,error=>error);
 const two=lease.release().then(()=>{secondSettled=true;return null},error=>{secondSettled=true;return error});
 await vi.advanceTimersByTimeAsync(0);
 try{expect(secondSettled).toBe(false)}
 finally{c.emit("close",0);await Promise.all([one,two])}
});

it.runIf(process.platform==="win32")("notifies subscribers of unexpected ownership loss but not normal release",async()=>{
 const c=helper(),d=root(),lease=await acquireMemoryOpenLease(d,d),lost=vi.fn();
 lease.onLost(lost);c.emit("close",1);await Promise.resolve();expect(lost).toHaveBeenCalledOnce();await lease.release().catch(()=>{});
 const next=helper(),normal=await acquireMemoryOpenLease(d,d),expected=vi.fn();normal.onLost(expected);
 next.stdin.once("finish",()=>next.emit("close",0));await normal.release();expect(expected).not.toHaveBeenCalled();
});
