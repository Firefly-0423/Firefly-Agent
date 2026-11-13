import { createCipheriv,createDecipheriv,randomBytes } from "node:crypto";
export interface PayloadBinding {readonly recordType:string;readonly id:string;readonly schemaVersion:number;readonly keyVersion:number}
const MAGIC=Buffer.from("FMM1"),HEADER=12,NONCE=12,TAG=16,MAX=8*1024*1024;
function aad(binding:PayloadBinding):Buffer{
 if(!binding||typeof binding!=="object"||typeof binding.recordType!=="string"||!/^\w[\w-]{0,47}$/.test(binding.recordType)||typeof binding.id!=="string"||binding.id.length===0||binding.id.length>256
 || !Number.isInteger(binding.schemaVersion)||binding.schemaVersion<1||binding.schemaVersion>0xffffffff||!Number.isInteger(binding.keyVersion)||binding.keyVersion<1||binding.keyVersion>0xffffffff)throw new Error("MEMORY_AAD_INVALID");
 return Buffer.from(JSON.stringify([binding.recordType,binding.id,binding.schemaVersion,binding.keyVersion]));
}
function checkedKey(key:Uint8Array):Uint8Array{if(!(key instanceof Uint8Array)||key.length!==32)throw new Error("MEMORY_KEY_INVALID");return key}
export function sealPayload(key:Uint8Array,binding:PayloadBinding,plaintext:Uint8Array):Buffer{
 const associated=aad(binding);
 if(!(plaintext instanceof Uint8Array)||plaintext.length>MAX)throw new Error("MEMORY_PAYLOAD_INVALID");
 const nonce=randomBytes(NONCE),cipher=createCipheriv("aes-256-gcm",checkedKey(key),nonce);cipher.setAAD(associated);
 const header=Buffer.alloc(HEADER);MAGIC.copy(header);header.writeUInt32LE(binding.schemaVersion,4);header.writeUInt32LE(binding.keyVersion,8);
 const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
 return Buffer.concat([header,nonce,cipher.getAuthTag(),ciphertext]);
}
export function openPayload(key:Uint8Array,binding:PayloadBinding,envelope:Uint8Array):Buffer{
 const associated=aad(binding);checkedKey(key);
 if(!(envelope instanceof Uint8Array)||envelope.length<HEADER+NONCE+TAG||envelope.length>HEADER+NONCE+TAG+MAX)throw new Error("MEMORY_ENVELOPE_INVALID");
 const value=Buffer.from(envelope);
 if(!value.subarray(0,4).equals(MAGIC))throw new Error("MEMORY_ENVELOPE_INVALID");
 let part:Buffer|undefined;
 try{
  if(value.readUInt32LE(4)!==binding.schemaVersion||value.readUInt32LE(8)!==binding.keyVersion)throw new Error("version mismatch");
  const decipher=createDecipheriv("aes-256-gcm",key,value.subarray(HEADER,HEADER+NONCE));
  decipher.setAAD(associated);decipher.setAuthTag(value.subarray(HEADER+NONCE,HEADER+NONCE+TAG));
  part=decipher.update(value.subarray(HEADER+NONCE+TAG));return Buffer.concat([part,decipher.final()]);
 }catch{throw new Error("MEMORY_AUTH_FAILED")}finally{part?.fill(0)}
}
