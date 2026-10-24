import {DatabaseSync} from "node:sqlite";
import {randomBytes} from "node:crypto";
import {expect,it} from "vitest";
import {PolicyRepository} from "./policy-repository";
import {initializeSchema} from "../memory-core/schema";
import {transactionNow,withTransactionClock} from "../memory-core/transaction-clock";
import {isFactEffectiveAt} from "./fact-validity";

it("a scalar now cannot bypass the worker transaction clock",()=>{
 const db=new DatabaseSync(":memory:"),key=randomBytes(32);initializeSchema(db,"m-synthetic-clock");
 const policy=new PolicyRepository(db,key);db.exec("BEGIN");
 try{withTransactionClock(db,()=>100,()=>{
  expect(()=>policy.eligibleFactsWithinTransaction("scope-a","actor-a",101)).toThrow("MEMORY_TRANSACTION_CLOCK_INVALID");
  expect(policy.eligibleFactsWithinTransaction("scope-a","actor-a",transactionNow(db))).toEqual([]);
 })}finally{db.exec("ROLLBACK");db.close();key.fill(0)}
});
it.each([NaN,Infinity,-1,0.5])("invalid effective-time sample fails closed: %s",now=>{
 expect(()=>isFactEffectiveAt({validFrom:null,validTo:null,referenceTime:null},now)).toThrow("MEMORY_TRANSACTION_CLOCK_INVALID");
});
it("half-open effective time does not synthesize null bounds",()=>{
 const unknown={validFrom:null,validTo:null,referenceTime:null};expect(isFactEffectiveAt(unknown,0)).toBe(true);expect(unknown).toEqual({validFrom:null,validTo:null,referenceTime:null});
 expect(isFactEffectiveAt({validFrom:100,validTo:200,referenceTime:null},100)).toBe(true);
 expect(isFactEffectiveAt({validFrom:100,validTo:200,referenceTime:null},200)).toBe(false);
 expect(()=>isFactEffectiveAt({validFrom:200,validTo:100,referenceTime:null},150)).toThrow("MEMORY_TIME_INVALID");
});
it("canonical negative safe-integer fact times remain valid",()=>{
 expect(isFactEffectiveAt({validFrom:-1000,validTo:null,referenceTime:-1000},100)).toBe(true);
 expect(isFactEffectiveAt({validFrom:null,validTo:-1000,referenceTime:-2000},100)).toBe(false);
 expect(()=>isFactEffectiveAt({validFrom:-0.5,validTo:null,referenceTime:null},100)).toThrow("MEMORY_TIME_INVALID");
});
