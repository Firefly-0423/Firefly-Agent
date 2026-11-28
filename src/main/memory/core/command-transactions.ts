import {createHmac,hkdfSync,timingSafeEqual} from "node:crypto";
import type {DatabaseSync} from "node:sqlite";
import {canonicalJson,internalId} from "./repository-types";
import {sealPayload,openPayload} from "./payload-codec";
import {withTransactionClock} from "./transaction-clock";
export type TransactionFault=(stage:"after-record"|"before-receipt")=>void;
/** Payload and receipt always commit together; request plaintext is cleared on every exit. */
export function executeTransaction<T>(input:{db:DatabaseSync;key:Uint8Array;scope:string;commandId:string;request:unknown;fault?:TransactionFault;clock?:()=>number;apply:()=>T}):T{
 internalId(input.scope);internalId(input.commandId);
 const request=Buffer.from(canonicalJson(input.request));let derived:Buffer|undefined,digest:Buffer;
 try{
  if(request.length>8*1024*1024)throw new Error("MEMORY_INPUT_INVALID");
  derived=Buffer.from(hkdfSync("sha256",input.key,Buffer.alloc(0),"FireflyMemoryReceiptDigest-v1",32));
  digest=createHmac("sha256",derived).update(request).digest();
 }finally{request.fill(0);derived?.fill(0)}
 const binding={recordType:"command-receipt",id:JSON.stringify([input.scope,input.commandId]),schemaVersion:1,keyVersion:1};
 input.db.exec("BEGIN IMMEDIATE");
 try{
  return withTransactionClock(input.db,input.clock??Date.now,()=>{
  const receipt=input.db.prepare("SELECT scope_key,request_digest,result FROM command_receipts WHERE command_id=?").get(input.commandId);
  if(receipt){
   if(receipt.scope_key!==input.scope||!(receipt.request_digest instanceof Uint8Array)||receipt.request_digest.length!==digest.length||!timingSafeEqual(digest,receipt.request_digest))throw new Error("MEMORY_COMMAND_CONFLICT");
   const plain=openPayload(input.key,binding,receipt.result as Uint8Array);
   let result:T;try{result=JSON.parse(plain.toString("utf8")) as T}finally{plain.fill(0)}
   input.db.exec("COMMIT");return result;
  }
  const result=input.apply();input.fault?.("before-receipt");
  const plain=Buffer.from(canonicalJson(result));let encrypted:Buffer;
  try{encrypted=sealPayload(input.key,binding,plain)}finally{plain.fill(0)}
  input.db.prepare("INSERT INTO command_receipts VALUES (?,?,?,?)").run(input.commandId,input.scope,digest,encrypted);
  input.db.exec("COMMIT");return result;
  });
 }catch(error){input.db.exec("ROLLBACK");throw error}
}
