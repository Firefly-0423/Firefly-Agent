import path from "node:path";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
const archive=fileURLToPath(new URL("./archive-reporter.mjs",import.meta.url));
/** CLI reporter flags replace Vitest config reporters; the supported entry always retains the archive. */
export function vitestArguments(args){return ["run",...args,...(args.some(a=>a==="--reporter"||a.startsWith("--reporter="))?[]:["--reporter=default"]),`--reporter=${archive}`]}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const child=spawn(process.execPath,[fileURLToPath(new URL("../../node_modules/vitest/vitest.mjs",import.meta.url)),...vitestArguments(process.argv.slice(2))],{stdio:"inherit",windowsHide:true});
 child.on("error",error=>{console.error(error.message);process.exitCode=1});child.on("exit",(code,signal)=>{process.exitCode=code??(signal?1:0)});
}
