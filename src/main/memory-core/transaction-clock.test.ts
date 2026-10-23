import {DatabaseSync} from "node:sqlite";
import {expect,it} from "vitest";
import {executeTransaction} from "./command-transactions";
import {transactionNow,withTransactionClock} from "./transaction-clock";

it("freezes one trusted now across nested consumers and samples the next transaction afresh",()=>{
 const db=new DatabaseSync(":memory:");let calls=0;
 try{
  const clock=()=>1000+calls++;
  expect(()=>transactionNow(db)).toThrow("MEMORY_TRANSACTION_REQUIRED");
  db.exec("BEGIN");
  expect(withTransactionClock(db,clock,()=>[transactionNow(db),withTransactionClock(db,()=>9999,()=>transactionNow(db)),transactionNow(db)])).toEqual([1000,1000,1000]);
  db.exec("COMMIT");expect(calls).toBe(1);
  db.exec("BEGIN");expect(()=>transactionNow(db)).toThrow("MEMORY_TRANSACTION_CLOCK_REQUIRED");
  expect(withTransactionClock(db,clock,()=>transactionNow(db))).toBe(1001);db.exec("COMMIT");expect(calls).toBe(2);
 }finally{db.close()}
});

it.each([NaN,Infinity,-1,1.5,Number.MAX_SAFE_INTEGER+1])("rejects invalid trusted clock %s before applying records",value=>{
 const db=new DatabaseSync(":memory:");let applied=false;
 try{
  db.exec("CREATE TABLE command_receipts(command_id TEXT,scope_key TEXT,request_digest BLOB,result BLOB)");
  expect(()=>executeTransaction({db,key:Buffer.alloc(32,1),scope:"scope-a",commandId:"invalid-clock",request:{},clock:()=>value,apply:()=>{applied=true;return {}}})).toThrow("MEMORY_TRANSACTION_CLOCK_INVALID");
  expect(applied).toBe(false);expect(db.isTransaction).toBe(false);
  expect(db.prepare("SELECT count(*) n FROM command_receipts").get()?.n).toBe(0);
 }finally{db.close()}
});

it("clears the trusted transaction time when an operation fails",()=>{
 const db=new DatabaseSync(":memory:");
 try{
  db.exec("BEGIN");expect(()=>withTransactionClock(db,()=>1000,()=>{throw new Error("INJECTED")})).toThrow("INJECTED");db.exec("ROLLBACK");
  db.exec("BEGIN");expect(()=>transactionNow(db)).toThrow("MEMORY_TRANSACTION_CLOCK_REQUIRED");
  expect(withTransactionClock(db,()=>2000,()=>transactionNow(db))).toBe(2000);db.exec("COMMIT");
 }finally{db.close()}
});
