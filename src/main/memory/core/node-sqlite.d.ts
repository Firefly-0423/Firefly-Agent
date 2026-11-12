/**
 * Minimal Node 24.18 API declarations used by memory-core.
 * The locked @types/node is 20.19; no runtime shim or dependency substitution.
 * Source: https://nodejs.org/download/release/v24.18.0/docs/api/sqlite.html
 */
declare module "node:sqlite" {
 export type SQLInputValue=null|number|bigint|string|Uint8Array;
 export type SQLOutputValue=null|number|bigint|string|Uint8Array;
 export interface StatementSync {
  get(...values:SQLInputValue[]):Record<string,SQLOutputValue>|undefined;
  all(...values:SQLInputValue[]):Record<string,SQLOutputValue>[];
  run(...values:SQLInputValue[]):{changes:number|bigint;lastInsertRowid:number|bigint};
 }
 export class DatabaseSync {
  constructor(path:string,options?:{readOnly?:boolean;enableForeignKeyConstraints?:boolean;allowExtension?:boolean});
  readonly isOpen:boolean;
  readonly isTransaction:boolean;
  exec(sql:string):void;
  prepare(sql:string):StatementSync;
  close():void;
 }
 export function backup(source:DatabaseSync,destination:string):Promise<number>;
}
