import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {EventEmitter} from "node:events";
import {PassThrough} from "node:stream";
import {spawn} from "node:child_process";
import {afterEach,it,expect,vi} from "vitest";
import {createWindowsKeyProtection} from "./windows-dpapi";
vi.mock("node:child_process",()=>({spawn:vi.fn()}));
const dirs:string[]=[];
afterEach(()=>{vi.useRealTimers();vi.resetAllMocks();for(const d of dirs.splice(0))fs.rmSync(d,{recursive:true,force:true})});
function provider(){const d=fs.mkdtempSync(path.join(os.tmpdir(),"memory-dpapi-"));dirs.push(d);return createWindowsKeyProtection(d)}
function child(stdout:Buffer,code=0,stderr=Buffer.alloc(0),hang=false){
 const c:any=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.stdin=new PassThrough();c.killed=false;c.closed=false;
 c.kill=()=>{c.killed=true;c.closed=true;c.emit("close",null,"SIGTERM");return true};
 c.stdin.once("finish",()=>{if(!hang)queueMicrotask(()=>{c.stdout.write(stdout);c.stderr.write(stderr);c.closed=true;c.emit("close",code,null)})});
 vi.mocked(spawn).mockReturnValue(c);return c;
}
function frame(value:Buffer){const head=Buffer.alloc(8);head.write("FMD1");head.writeUInt32LE(value.length,4);return Buffer.concat([head,value])}
it.runIf(process.platform==="win32")("round-trips validated binary helper responses without secret command arguments",async()=>{
 const p=provider(),key=Buffer.alloc(32,0x95);child(frame(Buffer.alloc(100,0x42)));
 const protectedBytes=await p.protect(key);expect(protectedBytes).toEqual(Buffer.alloc(100,0x42));
 const call=vi.mocked(spawn).mock.calls[0];expect(JSON.stringify(call.slice(0,2))).not.toContain(key.toString("base64"));
 child(frame(key));expect(await p.unprotect(protectedBytes)).toEqual(key);
});
it.runIf(process.platform==="win32").each([
 ["nonzero",frame(Buffer.alloc(32)),1],["truncated",Buffer.from("FMD"),0],
 ["bad-length",Buffer.from("FMD1\x02\x00\x00\x00x","binary"),0],["overflow",Buffer.alloc(65545),0]
])("refuses %s output without leaking native errors",async(_name,stdout,code)=>{
 const p=provider();child(stdout as Buffer,code as number);
 await expect(p.unprotect(Buffer.alloc(100))).rejects.toThrow(/^MEMORY_DPAPI_FAILED$/);
});
it.runIf(process.platform==="win32")("kills the timed-out owned helper and waits for close before rejecting",async()=>{
 vi.useFakeTimers();const p=provider(),c=child(Buffer.alloc(0),0,Buffer.alloc(0),true);
 const result=p.unprotect(Buffer.alloc(100)).then(()=>({error:null}),error=>({error}));
 await vi.advanceTimersByTimeAsync(10000);expect((await result).error?.message).toBe("MEMORY_DPAPI_FAILED");expect(c.killed&&c.closed).toBe(true);
});
