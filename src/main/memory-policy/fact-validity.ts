import type {FactTime} from "../../shared/memory-contracts";

/** Known bounds constrain recall; unknown bounds neither invent time nor grant permanence. */
export function isFactEffectiveAt(time:FactTime,now:number):boolean {
 if(!Number.isSafeInteger(now)||now<0)throw new Error("MEMORY_TRANSACTION_CLOCK_INVALID");
 const values=[time.validFrom,time.validTo,time.referenceTime];
 if(values.some(value=>value!==null&&!Number.isSafeInteger(value))
  ||(time.validFrom!==null&&time.validTo!==null&&time.validFrom>=time.validTo))throw new Error("MEMORY_TIME_INVALID");
 return (time.validFrom===null||now>=time.validFrom)&&(time.validTo===null||now<time.validTo);
}
