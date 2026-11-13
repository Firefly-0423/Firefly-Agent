import {test,after} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createRequire} from "node:module";
import {buildSync} from "esbuild";
// 仓库根目录：本文件在 scripts/verify/memory-core 下；node --test 从仓库根目录运行。
const cwd=path.resolve(import.meta.dirname,"..","..","..");
assert.equal(process.cwd(),cwd);
fs.mkdirSync(path.join(cwd,"output"),{recursive:true});
const fixture=fs.mkdtempSync(path.join(cwd,"output","probe-root-tests-"));
const link=path.join(os.tmpdir(),"probe-junction-"+path.basename(fixture));
const bundle=path.join(fixture,"root.cjs");
buildSync({entryPoints:["scripts/verify/memory-core/probe-root.ts"],outfile:bundle,bundle:true,platform:"node",format:"cjs"});
const {assertProbeRoot}=createRequire(import.meta.url)(bundle);
after(()=>{if(fs.existsSync(link))fs.unlinkSync(link);fs.rmSync(fixture,{recursive:true,force:true})});
test("rejects a different Windows drive before any key operation",()=>assert.throws(()=>assertProbeRoot(cwd,"F:\\not-authorized\\probe")));
test("rejects a different E drive working directory",()=>assert.throws(()=>assertProbeRoot("E:\\not-authorized","E:\\not-authorized\\output\\memory-core\\probe")));
test("rejects an external junction even when its lexical path is inside the probe root",()=>{
 fs.symlinkSync(fixture,link,"junction");assert.throws(()=>assertProbeRoot(cwd,link));
});
test("accepts a canonical child of the approved probe directory",()=>assert.doesNotThrow(()=>assertProbeRoot(cwd,path.join(cwd,"output","memory-core","new-probe"))));
test("rejects a sibling of the approved probe directory",()=>assert.throws(()=>assertProbeRoot(cwd,path.join(cwd,"output","memory-core-other","probe"))));
test("rejects a relative probe root",()=>assert.throws(()=>assertProbeRoot(cwd,path.join("output","memory-core","probe"))));
