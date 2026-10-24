import { describe,it,expect } from "vitest";
import { randomBytes } from "node:crypto";
import { sealPayload,openPayload } from "./payload-codec";
const key=randomBytes(32),meta={recordType:"fact",id:"01234567-89ab-cdef-0123-456789abcdef",schemaVersion:1,keyVersion:1};
describe("memory payload authentication",()=>{
 it.each(["中文事实","English fact","中文 and English 混合"])("round trips %s",text=>{
  const blob=sealPayload(key,meta,Buffer.from(text,"utf8"));
  expect(Buffer.from(openPayload(key,meta,blob)).toString("utf8")).toBe(text);
  expect(blob.includes(Buffer.from(text))).toBe(false);
 });
 it("uses a fresh nonce for the same input",()=>{expect(sealPayload(key,meta,Buffer.from("same"))).not.toEqual(sealPayload(key,meta,Buffer.from("same")))});
 it.each(["recordType","id","schemaVersion","keyVersion"] as const)("rejects changed %s AAD",field=>{
  const blob=sealPayload(key,meta,Buffer.from("secret"));
  expect(()=>openPayload(key,{...meta,[field]:typeof meta[field]==="number"?2:"different"},blob)).toThrow("MEMORY_AUTH_FAILED");
 });
 it.each([12,25,42])("rejects envelope tampering at %i",offset=>{
  const blob=sealPayload(key,meta,Buffer.from("payload"));blob[offset]^=1;
  expect(()=>openPayload(key,meta,blob)).toThrow();
 });
 it("rejects truncation, unknown format, bad key and malformed metadata",()=>{
  const blob=sealPayload(key,meta,Buffer.from("payload"));
  expect(()=>openPayload(key,meta,blob.subarray(0,15))).toThrow("MEMORY_ENVELOPE_INVALID");
  const unknown=Buffer.from(blob);unknown[0]^=1;
  expect(()=>openPayload(key,meta,unknown)).toThrow("MEMORY_ENVELOPE_INVALID");
  expect(()=>openPayload(randomBytes(32),meta,blob)).toThrow("MEMORY_AUTH_FAILED");
  expect(()=>sealPayload(key,{...meta,schemaVersion:0},Buffer.from("x"))).toThrow("MEMORY_AAD_INVALID");
 });
});
