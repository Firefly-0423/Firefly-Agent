import {it,expect,vi} from "vitest";
import {createMainMemoryAuthority} from "./main-access";
import {MemoryService} from "./memory-service";
const ref={sourceId:"source-a",revision:1};
const fact={subjectKey:"饮食偏好",assertion:"我偏好中文 English 🌱",assertionKind:"user-statement" as const,time:{validFrom:null,validTo:null,referenceTime:null}};
function fixture(change:Record<string,unknown>={}){
 const source={scopeKey:"scope-a",...ref,kind:"user" as const,intent:"statement" as const,policyEligibility:{directStatement:true,inferred:false,sensitive:false,conflict:false},...change};
 const authority=createMainMemoryAuthority({policyVersion:"policy-v1",resolveSource:()=>source as any});
 const client={execute:vi.fn(async(_command:unknown)=>({id:"synthetic",revision:1})),current:vi.fn(async()=>[])};
 return{authority,access:authority.access("scope-a"),service:new MemoryService(client),client};
}
it("rejects serialized or plain-object Main capabilities before issuing a command",async()=>{
 const f=fixture();await expect(f.service.current({scopeKey:"scope-a"})).rejects.toThrow("MEMORY_ACCESS_DENIED");
 await expect(f.service.current(JSON.parse(JSON.stringify(f.access)))).rejects.toThrow("MEMORY_ACCESS_DENIED");
 expect(f.client.current).not.toHaveBeenCalled();
});
it("checks authoritative Main source scope and revision rather than caller claims",async()=>{
 const f=fixture({scopeKey:"scope-b"});await expect(f.service.registerSource(f.access,"register",ref)).rejects.toThrow("MEMORY_SOURCE_INVALID");
 const g=fixture();await expect(g.service.registerSource(g.access,"register",{...ref,revision:2})).rejects.toThrow("MEMORY_SOURCE_INVALID");
 expect(f.client.execute).not.toHaveBeenCalled();expect(g.client.execute).not.toHaveBeenCalled();
});
it("model extraction only issues a candidate proposal",async()=>{
 const f=fixture();await f.service.proposeCandidate(f.access,{commandId:"proposal",candidateId:"candidate-a",evidenceId:"evidence-a",fact});
 expect(f.client.execute).toHaveBeenCalledOnce();expect(f.client.execute.mock.calls[0][0]).toMatchObject({kind:"proposeCandidate",scopeKey:"scope-a"});
});
it("rejects model-supplied confirmed/scope/owner fields",async()=>{
 const f=fixture();
 for(const extra of [{userConfirmed:true},{scopeKey:"scope-b"},{owner:"forged"}]){
  await expect(f.service.proposeCandidate(f.access,{commandId:"proposal",candidateId:"candidate-a",evidenceId:"evidence-a",fact,...extra} as any)).rejects.toThrow("MEMORY_INPUT_INVALID");
 }
 expect(f.client.execute).not.toHaveBeenCalled();
});
it("distinguishes policy acceptance from explicit user confirmation",async()=>{
 const f=fixture(),input={commandId:"activate",candidateId:"candidate-a"};
 const policy=f.authority.authorize(f.access,{candidateId:input.candidateId,sourceRef:ref,reason:"policyAccepted"});
 await f.service.activateCandidate(f.access,policy,input);
 expect(f.client.execute.mock.calls[0][0]).toMatchObject({body:{authorization:{reason:"policyAccepted",policyVersion:"policy-v1"}}});
 const g=fixture({intent:"confirmation",candidateId:"candidate-a"});
 const explicit=g.authority.authorize(g.access,{candidateId:input.candidateId,sourceRef:ref,reason:"explicitUserConfirmed"});
 await g.service.activateCandidate(g.access,explicit,input);
 expect(g.client.execute.mock.calls[0][0]).toMatchObject({body:{authorization:{reason:"explicitUserConfirmed",policyVersion:null}}});
});
it.each(["inferred","sensitive","conflict"])("keeps %s policy proposals awaiting confirmation",field=>{
 const f=fixture({policyEligibility:{directStatement:true,inferred:false,sensitive:false,conflict:false,[field]:true}});
 expect(()=>f.authority.authorize(f.access,{candidateId:"candidate-a",sourceRef:ref,reason:"policyAccepted"})).toThrow("MEMORY_ACTIVATION_DENIED");
});
it("rejects a model-authored role and forged activation token",async()=>{
 const f=fixture({kind:"assistant"});expect(()=>f.authority.authorize(f.access,{candidateId:"candidate-a",sourceRef:ref,reason:"policyAccepted"})).toThrow("MEMORY_ACTIVATION_DENIED");
 const g=fixture();await expect(g.service.activateCandidate(g.access,{reason:"explicitUserConfirmed"},{commandId:"activate",candidateId:"candidate-a"})).rejects.toThrow("MEMORY_ACTIVATION_DENIED");
 expect(g.client.execute).not.toHaveBeenCalled();
});
it("binds activation to the exact Main capability and candidate",async()=>{
 const f=fixture(),token=f.authority.authorize(f.access,{candidateId:"candidate-a",sourceRef:ref,reason:"policyAccepted"});
 await expect(f.service.activateCandidate(f.authority.access("scope-a"),token,{commandId:"activate",candidateId:"candidate-a"})).rejects.toThrow("MEMORY_ACTIVATION_DENIED");
 await expect(f.service.activateCandidate(f.access,token,{commandId:"activate",candidateId:"candidate-b"})).rejects.toThrow("MEMORY_ACTIVATION_DENIED");
});
it("preserves unknown times and rejects invalid half-open intervals",async()=>{
 const f=fixture();await f.service.proposeCandidate(f.access,{commandId:"proposal",candidateId:"candidate-a",evidenceId:"evidence-a",fact});
 expect(f.client.execute.mock.calls[0][0]).toMatchObject({body:{fact:{time:{validFrom:null,validTo:null,referenceTime:null}}}});
 await expect(f.service.proposeCandidate(f.access,{commandId:"bad-time",candidateId:"candidate-b",evidenceId:"evidence-a",fact:{...fact,time:{validFrom:20,validTo:20,referenceTime:null}}})).rejects.toThrow("MEMORY_TIME_INVALID");
});

it.each(["sensitive","conflict"])("revalidates changed %s policy conditions when using a previously issued token",async field=>{
 const source:any={scopeKey:"scope-a",...ref,kind:"user",intent:"statement",policyEligibility:{directStatement:true,inferred:false,sensitive:false,conflict:false}};
 const authority=createMainMemoryAuthority({policyVersion:"policy-v1",resolveSource:()=>source}),access=authority.access("scope-a");
 const client={execute:vi.fn(async()=>({id:"synthetic",revision:1})),current:vi.fn(async()=>[])},service=new MemoryService(client);
 const token=authority.authorize(access,{candidateId:"candidate-a",sourceRef:ref,reason:"policyAccepted"});
 source.policyEligibility[field]=true;
 await expect(service.activateCandidate(access,token,{commandId:"activate",candidateId:"candidate-a"})).rejects.toThrow("MEMORY_ACTIVATION_DENIED");
 expect(client.execute).not.toHaveBeenCalled();
});
it("revalidates changed explicit confirmation intent and target when consuming a token",async()=>{
 const source:any={scopeKey:"scope-a",...ref,kind:"user",intent:"confirmation",candidateId:"candidate-a"};
 const authority=createMainMemoryAuthority({policyVersion:"policy-v1",resolveSource:()=>source}),access=authority.access("scope-a");
 const client={execute:vi.fn(async()=>({id:"synthetic",revision:1})),current:vi.fn(async()=>[])},service=new MemoryService(client);
 const token=authority.authorize(access,{candidateId:"candidate-a",sourceRef:ref,reason:"explicitUserConfirmed"});
 source.candidateId="candidate-b";
 await expect(service.activateCandidate(access,token,{commandId:"activate",candidateId:"candidate-a"})).rejects.toThrow("MEMORY_ACTIVATION_DENIED");
 source.candidateId="candidate-a";source.intent="statement";
 await expect(service.activateCandidate(access,token,{commandId:"activate",candidateId:"candidate-a"})).rejects.toThrow("MEMORY_ACTIVATION_DENIED");
 expect(client.execute).not.toHaveBeenCalled();
});
