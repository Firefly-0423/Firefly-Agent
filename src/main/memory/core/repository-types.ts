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
export { canonicalJson } from "../../base/utils/canonical-json";
