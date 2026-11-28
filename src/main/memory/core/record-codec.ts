import {sealPayload,openPayload} from "./payload-codec";
import {canonicalJson} from "./repository-types";
export class RecordCodec {
 constructor(private readonly key:Uint8Array){}
 private binding(table:string,scope:string,id:string){return{recordType:table,id:JSON.stringify([scope,id]),schemaVersion:1,keyVersion:1}}
 seal(table:string,scope:string,id:string,value:unknown):Buffer{
  const plain=Buffer.from(canonicalJson(value));
  try{return sealPayload(this.key,this.binding(table,scope,id),plain)}finally{plain.fill(0)}
 }
 open<T>(table:string,scope:string,id:string,value:unknown):T{
  if(!(value instanceof Uint8Array))throw new Error("MEMORY_DATA_INVALID");
  const plain=openPayload(this.key,this.binding(table,scope,id),value);
  try{return JSON.parse(plain.toString("utf8")) as T}finally{plain.fill(0)}
 }
}
