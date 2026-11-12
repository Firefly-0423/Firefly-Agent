/** Worker-internal contracts; never exposed through Renderer IPC. */
export const ENTITY_TABLES=["sources","evidence","candidates","fact_revisions","current_facts","jobs","deletion_markers","index_state"] as const;
export type EntityTable=typeof ENTITY_TABLES[number];
export interface NewMemoryRow {
 readonly table:EntityTable;readonly id:string;readonly revision:number;
 readonly sourceId?:string;readonly parentId?:string;readonly state?:string;
 readonly payload:unknown;
}
export interface BatchCommand {readonly commandId:string;readonly scopeKey:string;readonly records:readonly NewMemoryRow[]}
export interface MemoryRow {readonly id:string;readonly revision:number;readonly sourceId:string|null;readonly parentId:string|null;readonly state:string;readonly payload:unknown}
export interface BatchResult {readonly inserted:number}
export function internalId(value:unknown):asserts value is string{
 if(typeof value!=="string"||!/[a-zA-Z0-9_-]/.test(value)||!/^[-a-zA-Z0-9_]{1,96}$/.test(value))throw new Error("MEMORY_INPUT_INVALID");
}
export function entityTable(value:unknown):asserts value is EntityTable{
 if(!ENTITY_TABLES.includes(value as EntityTable))throw new Error("MEMORY_INPUT_INVALID");
}
/** Stable request representation; rejects non-JSON values and excessive nesting. */
export function canonicalJson(value:unknown,depth=0):string{
 if(depth>64)throw new Error("MEMORY_INPUT_INVALID");
 if(value===null)return "null";
 if(typeof value==="string"||typeof value==="boolean")return JSON.stringify(value);
 if(typeof value==="number"&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value)){for(let i=0;i<value.length;i++)if(!Object.prototype.hasOwnProperty.call(value,i))throw new Error("MEMORY_INPUT_INVALID");return "["+value.map(v=>canonicalJson(v,depth+1)).join(",")+"]";}
 if(typeof value==="object"&&value&&Object.getPrototypeOf(value)===Object.prototype){
  return "{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+canonicalJson((value as Record<string,unknown>)[k],depth+1)).join(",")+"}";
 }
 throw new Error("MEMORY_INPUT_INVALID");
}
