import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {afterEach,describe,it,expect,vi} from "vitest";
import {spawn} from "node:child_process";
import {acquireWriterOwnership} from "./writer-ownership";
vi.mock("node:child_process",()=>({spawn:vi.fn(()=>{throw new Error("UNEXPECTED_HELPER")})}));
// FIRST_PIPE_INSTANCE exclusivity and case/junction identity require the Windows kernel.
describe.runIf(process.platform==="win32")("Windows named-pipe writer ownership",()=>{
const dirs:string[]=[],leases:any[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const lease of leases.splice(0))await lease.release();for(const dir of dirs.splice(0))fs.rmSync(dir,{recursive:true,force:true})});
function root(){const d=fs.mkdtempSync(path.join(os.tmpdir(),"memory-writer-"));dirs.push(d);return d}
it("keeps exclusive ownership until release and does not depend on a helper process",async()=>{
 const d=root(),one=await acquireWriterOwnership(d);leases.push(one);
 await expect(acquireWriterOwnership(d)).rejects.toThrow("MEMORY_OPEN_BUSY");
 one.assertHeld();expect(spawn).not.toHaveBeenCalled();
 await one.release();const next=await acquireWriterOwnership(d);leases.push(next);next.assertHeld();
});
it("treats junction and case aliases as the same profile owner",async()=>{
 const d=root(),alias=path.join(root(),"alias");fs.symlinkSync(d,alias,"junction");
 const one=await acquireWriterOwnership(d);leases.push(one);
 await expect(acquireWriterOwnership(alias)).rejects.toThrow("MEMORY_OPEN_BUSY");
 await expect(acquireWriterOwnership(d.toUpperCase())).rejects.toThrow("MEMORY_OPEN_BUSY");
});
it("owns different profiles independently and shares release completion",async()=>{
 const one=await acquireWriterOwnership(root()),two=await acquireWriterOwnership(root());leases.push(one,two);
 const lost=vi.fn();one.onLost(lost);
 const a=one.release(),b=one.release();expect(a).toBe(b);await a;two.assertHeld();expect(lost).not.toHaveBeenCalled();
 expect(()=>one.assertHeld()).toThrow("MEMORY_WRITER_LOCK_LOST");
});

});
