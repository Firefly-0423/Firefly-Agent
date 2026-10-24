import {randomBytes} from "node:crypto";
import {DatabaseSync} from "node:sqlite";
import {afterEach,beforeEach,describe,expect,it} from "vitest";
import type {BoundSourceRef,FactView} from "../../shared/memory-contracts";
import {MemoryRepository} from "../memory-core/repository";
import {initializeSchema} from "../memory-core/schema";
import {RecordCodec} from "../memory-core/record-codec";
import {Suppression} from "../memory-core/suppression";
import {withTransactionClock} from "../memory-core/transaction-clock";
import {FactSupports,type ConfirmationProof} from "./fact-supports";

const SCOPE="scope-a";
let repo:MemoryRepository;
let db:DatabaseSync;
let key:Buffer;
let supports:FactSupports;
let sourceSequence=0;

function publishSource(overrides:Record<string,unknown>={}):BoundSourceRef{
 sourceSequence+=1;
 const messageId=typeof overrides.messageId==="string"?overrides.messageId:`message-${sourceSequence}`;
 const identity={providerId:"provider-a",sessionId:"session-a",messageId};
 const observation={...identity,contentRevision:1,generation:`generation-${sourceSequence}`,state:"live",role:"user",trust:"direct-user-event",fingerprint:"a".repeat(64),...overrides};
 const reservation=repo.sourceCommand({kind:"reserve",scopeKey:SCOPE,commandId:`reserve-${sourceSequence}`,body:{identity,expectedRef:null}}) as {sourceId:string;operationId:string};
 return repo.sourceCommand({kind:"finish",scopeKey:SCOPE,commandId:`finish-${sourceSequence}`,body:{sourceId:reservation.sourceId,operationId:reservation.operationId,observation}}) as BoundSourceRef;
}
function fact(sourceRef:BoundSourceRef,overrides:Partial<FactView>={}):FactView{
 return{
  factId:"fact-a",revision:1,subjectKey:"coffee",assertion:"likes coffee",assertionKind:"user-statement",
  time:{validFrom:null,validTo:null,referenceTime:null},sourceRef,
  recordedAt:1,acceptedAt:1,supersededAt:null,activationReason:"policyAccepted",policyVersion:null,
  provenance:{candidateId:null,evidenceId:null,activationSourceRef:sourceRef},
  ...overrides,
 };
}
function tx<T>(operation:()=>T):T{
 db.exec("BEGIN");
 try{const value=operation();db.exec("COMMIT");return value}catch(error){db.exec("ROLLBACK");throw error}
}
function txAt<T>(now:number,operation:()=>T):T{
 db.exec("BEGIN");
 try{
  const value=withTransactionClock(db,()=>now,operation);
  db.exec("COMMIT");
  return value;
 }catch(error){db.exec("ROLLBACK");throw error}
}
function proof(action:ConfirmationProof["action"]="confirm"):ConfirmationProof{
 return{nonce:"nonce",targetId:"fact-a",targetRevision:1,action};
}
function suppressSource(scope:string,ref:BoundSourceRef,factId="fact-a"):void{
 const codec=new RecordCodec(key);
 const id=`marker-${sourceSequence}-${Math.random()}`;
 const marker={factId,sourceRef:ref,forgetEvent:{sourceId:"forget",revision:1},at:1,origins:[ref],subjects:["coffee"]};
 db.prepare("INSERT INTO deletion_markers(id,scope_key,revision,source_id,parent_id,state,payload) VALUES(?,?,1,NULL,NULL,'forgotten',?)").run(id,scope,codec.seal("deletion_markers",scope,id,marker));
}

beforeEach(()=>{
 key=randomBytes(32);
 db=new DatabaseSync(":memory:",{enableForeignKeyConstraints:true,allowExtension:false});
 initializeSchema(db,"fact-supports-fixture");
 repo=new MemoryRepository(db,Buffer.from(key),":memory:","fact-supports-fixture");
 supports=new FactSupports(db,key);
 sourceSequence=0;
});
afterEach(()=>{repo.close();key.fill(0)});

describe("FactSupports.add / audit",()=>{
 it("requires a transaction",()=>{
  const ref=publishSource();
  expect(()=>supports.add(SCOPE,"actor",fact(ref),ref,"automatic")).toThrow("MEMORY_TRANSACTION_REQUIRED");
 });
 it("stores an automatic support once and reports it as eligible",()=>{
  const ref=publishSource();
  tx(()=>{
   supports.add(SCOPE,"actor",fact(ref),ref,"automatic");
   supports.add(SCOPE,"actor",fact(ref),ref,"automatic");
   const audit=supports.audit(SCOPE,"actor",fact(ref).factId,fact(ref));
   expect(audit.status).toBe("eligible");
   expect(audit.reason).toBe("valid-support");
   expect(audit.revision).toBe(1);
   expect(audit.supports).toHaveLength(1);
   expect(audit.supports[0]).toMatchObject({sourceRef:ref,kind:"automatic",factRevision:1,validity:"valid",proof:null});
  });
 });
 it("requires an explicit proof exactly for explicit confirmations",()=>{
  const ref=publishSource();
  tx(()=>{
   expect(()=>supports.add(SCOPE,"actor",fact(ref),ref,"explicitUserConfirmed")).toThrow("MEMORY_EVENT_DENIED");
   expect(()=>supports.add(SCOPE,"actor",fact(ref),ref,"automatic",proof())).toThrow("MEMORY_EVENT_DENIED");
  });
 });
 it("rejects confirmations that reuse an automatic source",()=>{
  const ref=publishSource();
  tx(()=>{
   supports.add(SCOPE,"actor",fact(ref),ref,"automatic");
   expect(()=>supports.add(SCOPE,"actor",fact(ref),ref,"explicitUserConfirmed",proof("confirm"))).toThrow("MEMORY_CONFIRMATION_NOT_INDEPENDENT");
   expect(()=>supports.add(SCOPE,"actor",fact(ref),ref,"explicitUserConfirmed",proof("confirmFact"))).toThrow("MEMORY_CONFIRMATION_NOT_INDEPENDENT");
  });
 });
 it("denies sources that are not trusted direct user events",()=>{
  const ref=publishSource({role:"assistant",trust:"model"});
  tx(()=>expect(()=>supports.add(SCOPE,"actor",fact(ref),ref,"automatic")).toThrow("MEMORY_EVENT_DENIED"));
 });
 it("denies sources blocked by a suppression marker",()=>{
  const ref=publishSource();
  suppressSource(SCOPE,ref);
  tx(()=>expect(()=>supports.add(SCOPE,"actor",fact(ref),ref,"automatic")).toThrow("MEMORY_EVENT_DENIED"));
 });
 it("denies future-dated sources using the transaction clock",()=>{
  const ref=publishSource({occurredAt:5_000});
  txAt(1_000,()=>expect(()=>supports.add(SCOPE,"actor",fact(ref),ref,"automatic")).toThrow("MEMORY_POLICY_FUTURE"));
 });
 it("reports a support whose source was later deleted as deleted",()=>{
  const ref=publishSource();
  tx(()=>supports.add(SCOPE,"actor",fact(ref),ref,"automatic"));
  publishSource({contentRevision:2,state:"deleted",messageId:ref.binding.messageId,generation:ref.binding.generation});
  tx(()=>{
   const audit=supports.audit(SCOPE,"actor",fact(ref).factId,fact(ref));
   expect(audit.supports[0].validity).toBe("deleted");
   expect(audit.status).toBe("pending-review");
   expect(audit.reason).toBe("no-valid-support");
  });
 });
});

describe("FactSupports.deny",()=>{
 it("records a review and makes the fact pending explicit denial",()=>{
  const ref=publishSource();
  tx(()=>{
   supports.deny(SCOPE,"actor",fact(ref),ref,"nonce");
   const audit=supports.audit(SCOPE,"actor",fact(ref).factId,fact(ref));
   expect(audit.status).toBe("pending-review");
   expect(audit.reason).toBe("explicit-denial");
   expect(audit.reviews).toEqual([{sourceRef:ref,factRevision:1}]);
  });
 });
 it("requires a transaction and rejects untrusted sources",()=>{
  const trusted=publishSource();
  expect(()=>supports.deny(SCOPE,"actor",fact(trusted),trusted,"nonce")).toThrow("MEMORY_TRANSACTION_REQUIRED");
  const untrusted=publishSource({trust:"history"});
  tx(()=>expect(()=>supports.deny(SCOPE,"actor",fact(untrusted),untrusted,"nonce")).toThrow("MEMORY_EVENT_DENIED"));
 });
});

describe("FactSupports.bootstrap",()=>{
 it("adds automatic provenance only for policy-accepted, bound facts",()=>{
  const ref=publishSource();
  tx(()=>{
   supports.bootstrap(SCOPE,"actor",fact(ref));
   expect(supports.audit(SCOPE,"actor","fact-a",fact(ref)).supports[0].kind).toBe("automatic");
   supports.bootstrap(SCOPE,"actor",fact(ref,{activationReason:"explicitUserConfirmed"}));
   expect(supports.audit(SCOPE,"actor","fact-a",fact(ref)).supports).toHaveLength(1);
  });
 });
 it("does nothing when the source reference has no binding",()=>{
  const ref=publishSource();
  const unbound=fact({sourceId:ref.sourceId,revision:ref.revision});
  tx(()=>{
   supports.bootstrap(SCOPE,"actor",unbound);
   const audit=supports.audit(SCOPE,"actor","fact-a",unbound);
   expect(audit.supports).toEqual([]);
   expect(audit.status).toBe("pending-review");
  });
 });
});

describe("FactSupports.audit",()=>{
 it("reports forgotten when the fact is no longer current",()=>{
  const ref=publishSource();
  tx(()=>{
   supports.add(SCOPE,"actor",fact(ref),ref,"automatic");
   const audit=supports.audit(SCOPE,"actor","fact-a",undefined);
   expect(audit).toMatchObject({revision:null,status:"forgotten",reason:"forgotten"});
   expect(audit.supports).toHaveLength(1);
  });
 });
 it("filters supports and reviews by actor",()=>{
  const ref=publishSource();
  tx(()=>{
   supports.add(SCOPE,"actor-a",fact(ref),ref,"automatic");
   supports.deny(SCOPE,"actor-b",fact(ref),ref,"nonce");
   const audit=supports.audit(SCOPE,"actor-a",fact(ref).factId,fact(ref));
   expect(audit.supports).toHaveLength(1);
   expect(audit.reviews).toEqual([]);
  });
 });
});

describe("FactSupports.obsoleteOrigins",()=>{
 it("returns only earlier-revision supports for the same actor",()=>{
  const first=publishSource();
  const second=publishSource();
  const base=fact(first);
  tx(()=>{
   supports.add(SCOPE,"actor",base,first,"automatic");
   supports.add(SCOPE,"actor",{...base,revision:2},second,"automatic");
   expect(supports.obsoleteOrigins(SCOPE,"actor","fact-a",2)).toEqual([first]);
   expect(supports.obsoleteOrigins(SCOPE,"actor","fact-a",3)).toHaveLength(2);
   expect(supports.obsoleteOrigins(SCOPE,"actor","fact-a",3)).toEqual(expect.arrayContaining([first,second]));
   expect(supports.obsoleteOrigins(SCOPE,"other","fact-a",3)).toEqual([]);
  });
 });
});

describe("FactSupports.orderingTime",()=>{
 it("uses the latest occurredAt of valid automatic supports",()=>{
  const older=publishSource({occurredAt:1_000});
  const newer=publishSource({occurredAt:3_000});
  const base=fact(older);
  txAt(5_000,()=>{
   supports.add(SCOPE,"actor",base,older,"automatic");
   supports.add(SCOPE,"actor",base,newer,"automatic");
   expect(supports.orderingTime(SCOPE,"actor",base)).toBe(3_000);
  });
 });
 it("uses the declaration reference time for generic confirmations",()=>{
  const ref=publishSource({occurredAt:1_000});
  const value=fact(ref,{time:{validFrom:null,validTo:null,referenceTime:7_000}});
  txAt(10_000,()=>{
   supports.add(SCOPE,"actor",value,ref,"explicitUserConfirmed",proof("confirm"));
   expect(supports.orderingTime(SCOPE,"actor",value)).toBe(7_000);
  });
 });
 it("returns null when no support is valid",()=>{
  const ref=publishSource();
  tx(()=>{
   supports.bootstrap(SCOPE,"actor",fact(ref,{activationReason:"explicitUserConfirmed"}));
   expect(supports.orderingTime(SCOPE,"actor",fact(ref,{activationReason:"explicitUserConfirmed"}))).toBeNull();
  });
 });
});

describe("FactSupports.forget",()=>{
 it("suppresses supports and reviews and returns their source references",()=>{
  const supportRef=publishSource();
  const reviewRef=publishSource();
  tx(()=>{
   supports.add(SCOPE,"actor",fact(supportRef),supportRef,"automatic");
   supports.deny(SCOPE,"actor",fact(reviewRef),reviewRef,"nonce");
   const refs=supports.forget(SCOPE,"actor","fact-a");
   expect(refs).toEqual([supportRef,reviewRef]);
   const audit=supports.audit(SCOPE,"actor","fact-a",fact(supportRef));
   expect(audit.supports[0].validity).toBe("suppressed");
   expect(audit.status).toBe("pending-review");
   expect(audit.reason).toBe("no-valid-support");
   expect(audit.reviews).toEqual([{sourceRef:reviewRef,factRevision:1}]);
  });
 });
 it("leaves another actor's supports untouched",()=>{
  const ref=publishSource();
  tx(()=>{
   supports.add(SCOPE,"actor-a",fact(ref),ref,"automatic");
   expect(supports.forget(SCOPE,"actor-b","fact-a")).toEqual([]);
   expect(supports.audit(SCOPE,"actor-a","fact-a",fact(ref)).supports[0].validity).toBe("valid");
  });
 });
 it("leaves another actor's denial active",()=>{
  const ref=publishSource();
  tx(()=>{
   supports.add(SCOPE,"actor-a",fact(ref),ref,"automatic");
   supports.deny(SCOPE,"actor-a",fact(ref),ref,"nonce-a");
   supports.deny(SCOPE,"actor-b",fact(ref),ref,"nonce-b");
   supports.forget(SCOPE,"actor-a","fact-a");
   expect(supports.audit(SCOPE,"actor-a","fact-a",fact(ref)).reason).toBe("no-valid-support");
   expect(supports.audit(SCOPE,"actor-b","fact-a",fact(ref)).reason).toBe("explicit-denial");
  });
 });
});
