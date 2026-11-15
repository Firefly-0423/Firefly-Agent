import fs from "node:fs";
import path from "node:path";
import {canonicalPath,within} from "../../../src/main/base/identity/runtime-profile";
/** 探针只在 Firefly 仓库根目录运行：该目录下有本文件，且 package.json 的 name 为 firefly-agent。 */
export function isProbeWorkspace(cwd:string):boolean{
 try{
  return path.isAbsolute(cwd)&&fs.existsSync(path.join(cwd,"scripts","verify","memory-core","probe-root.ts"))&&JSON.parse(fs.readFileSync(path.join(cwd,"package.json"),"utf8")).name==="firefly-agent";
 }catch{return false}
}
/** 探针写入的根目录必须解析到仓库的 output/memory-core 之内（含 junction 解析）。 */
export function assertProbeRoot(cwd:string,root:string|undefined):asserts root is string{
 if(!isProbeWorkspace(cwd)||!root||!path.isAbsolute(root)||!within(canonicalPath(path.join(cwd,"output","memory-core")),canonicalPath(root)))throw new Error("PROBE_ROOT_INVALID");
}
