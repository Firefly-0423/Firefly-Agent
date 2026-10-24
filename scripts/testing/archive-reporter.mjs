import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {randomUUID,createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..");
function revision(){try{const git=(...args)=>execFileSync("git",args,{cwd:repo,encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"]});return {head:git("rev-parse","HEAD").trim(),branch:git("branch","--show-current").trim(),dirty:git("status","--porcelain=v1").split(/\r?\n/).filter(Boolean),diffSha256:createHash("sha256").update(git("diff","--binary","HEAD")).digest("hex"),untracked:git("ls-files","--others","--exclude-standard").split(/\r?\n/).filter(Boolean).map(file=>({file,sha256:createHash("sha256").update(fs.readFileSync(path.join(repo,file))).digest("hex")}))}}catch(error){return {unavailable:error.code??"GIT_REVISION_UNAVAILABLE"}}}
/** Archive every invocation through the existing Vitest configuration, including incomplete runs. */
export default class ArchiveReporter {
 file;
 report;
 onInit(){const root=path.resolve(process.env.FIREFLY_TEST_REPORT_ROOT??path.join(os.tmpdir(),"firefly-test-reports")),run=path.join(root,new Date().toISOString().replace(/[:.]/g,"-")+"-"+randomUUID());fs.mkdirSync(run,{recursive:true});this.file=path.join(run,"report.json");this.report={schemaVersion:1,status:"running",startedAt:new Date().toISOString(),revision:revision(),environment:{node:process.version,vitest:JSON.parse(fs.readFileSync(path.join(repo,"node_modules/vitest/package.json"),"utf8")).version,platform:process.platform,arch:process.arch,osRelease:os.release(),cwd:process.cwd(),temp:process.env.TEMP??null,tmp:process.env.TMP??null,bash:process.env.FIREFLY_TEST_BASH??null},cases:[],skipped:[]};this.save()}
 save(){fs.writeFileSync(this.file+".tmp",JSON.stringify(this.report,null,2)+"\n");fs.renameSync(this.file+".tmp",this.file)}
 onTestRunEnd(modules,errors,reason){const cases=[];for(const module of modules)for(const test of module.children.allTests()){const result=test.result();cases.push({file:test.module.moduleId,name:test.fullName,state:result.state,...(result.state==="skipped"?{reason:result.note??`no explicit reason supplied (mode=${test.options.mode})`,reasonProvided:typeof result.note==="string"&&result.note.length>0}:{})})}const counts={};for(const c of cases)counts[c.state]=(counts[c.state]??0)+1;this.report={...this.report,status:"completed",finishedAt:new Date().toISOString(),endRevision:revision(),reason,unhandledErrors:errors.length,counts,cases,skipped:cases.filter(c=>c.state==="skipped")};this.save();for(const c of this.report.skipped)process.stdout.write(`[test-skip] ${c.file} :: ${c.name} :: ${c.reason}\n`);process.stdout.write(`[test-archive] ${this.file}\n`)}
}
