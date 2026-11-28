import type {DatabaseSync} from "node:sqlite";

const times=new WeakMap<DatabaseSync,number>();

/** Worker-internal time only. A DTO or model query cannot supply this capability. */
export function transactionNow(db:DatabaseSync):number {
 if(!db.isTransaction)throw new Error("MEMORY_TRANSACTION_REQUIRED");
 const now=times.get(db);
 if(now===undefined)throw new Error("MEMORY_TRANSACTION_CLOCK_REQUIRED");
 return now;
}

/** Call after BEGIN, around the synchronous transaction body. Nested consumers share now. */
export function withTransactionClock<T>(db:DatabaseSync,clock:()=>number,operation:()=>T):T {
 if(!db.isTransaction)throw new Error("MEMORY_TRANSACTION_REQUIRED");
 if(times.has(db))return operation();
 const now=clock();
 if(!Number.isSafeInteger(now)||now<0)throw new Error("MEMORY_TRANSACTION_CLOCK_INVALID");
 times.set(db,now);
 try{return operation()}finally{times.delete(db)}
}
