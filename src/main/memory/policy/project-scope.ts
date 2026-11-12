import {createHash} from "node:crypto";
import path from "node:path";
import type {Attribute} from "./extractor";

/**
 * Project isolation for user facts.
 *
 * A fact is either global (the default; every session of the desktop user sees it) or
 * bound to one project, which is one bound workspace root. Only tool-type attributes can be
 * project bound: a shell or language runtime is a property of the code base, while the
 * user's language, address and answer style follow the person. Explicit work/personal
 * contexts are the user's own partition and are never narrowed further.
 *
 * The project key is mixed into the fact's subject key only when it applies, so every
 * fact stored before this existed keeps its subject key and stays global.
 */
export const PROJECT_SCOPED_ATTRIBUTES:ReadonlySet<Attribute>=new Set<Attribute>(["shell","programming-usage"]);
const PROJECT_KEY=/^project-[a-f0-9]{64}$/;

export function isProjectKey(value:unknown):value is string {return typeof value==="string"&&PROJECT_KEY.test(value)}
export function projectFail():never {throw new Error("MEMORY_PROJECT_INVALID")}

/** Windows paths are case-insensitive and accept both separators; other roots are used as written. */
function normalizedRoot(root:string):string {
 const windows=/^[a-zA-Z]:[\\/]|^\\\\/.test(root);
 if(!windows)return path.posix.normalize(root).replace(/(?<=.)\/+$/,"");
 return path.win32.normalize(root).replace(/\\/g,"/").replace(/(?<=.)\/+$/,"").toLowerCase();
}
/** Opaque, stable key for a canonical workspace root (ConversationWorkspaceBinding.workspaceRoot). */
export function projectKeyForWorkspaceRoot(root:string):string {
 if(typeof root!=="string"||!root.trim()||root.length>4096)projectFail();
 return "project-"+createHash("sha256").update("firefly-memory-project-v1\0"+normalizedRoot(root.trim())).digest("hex");
}

/** The actor's live project binding. It is read at each use because a workspace can be rebound. */
export function resolveProject(actor:{project?:()=>string|undefined}):string|undefined {
 const value=actor.project?.();
 if(value===undefined)return undefined;
 if(!isProjectKey(value))projectFail();
 return value;
}
/** The project a claim belongs to, or undefined when it is global. */
export function projectForClaim(claim:{attribute:Attribute;context:string},project:string|undefined):string|undefined {
 return project!==undefined&&claim.context==="default"&&PROJECT_SCOPED_ATTRIBUTES.has(claim.attribute)?project:undefined;
}
