import path from "node:path";
import {canonicalPath,within} from "../../../src/main/runtime-profile";
export const PROBE_CWD="E:\\Codex\\Firefly_Agent-skills-layout\\output\\task-b-memory-core";
export function assertProbeRoot(cwd:string,root:string|undefined):asserts root is string{
 if(cwd!==PROBE_CWD||!root||!path.isAbsolute(root)||!within(canonicalPath(path.join(PROBE_CWD,"output","memory-core")),canonicalPath(root)))throw new Error("PROBE_ROOT_INVALID");
}
