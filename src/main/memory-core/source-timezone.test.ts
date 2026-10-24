import {expect,it} from "vitest";
import {parseSourceObservation} from "./source-ledger";
const observation={providerId:"desktop",sessionId:"session",messageId:"message",contentRevision:1,generation:"generation",state:"live",role:"user",trust:"direct-user-event",fingerprint:"a".repeat(64),occurredAt:1700000000000};
it("retains a validated host calendar zone with the source observation",()=>{
 expect(parseSourceObservation({...observation,timeZone:"America/New_York"})).toEqual({...observation,timeZone:"America/New_York"});
 expect(parseSourceObservation(observation)).toEqual(observation);
});
it.each(["invalid/zone","",42,null])("refuses an invalid persisted timezone %s",timeZone=>expect(()=>parseSourceObservation({...observation,timeZone})).toThrow("MEMORY_TIME_INVALID"));
