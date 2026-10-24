import fs from "node:fs";
import path from "node:path";
import {describe,expect,it} from "vitest";
import {scanSkills} from "./skill-scanner";
import {buildSkillOwnership,createSpecialistProfiles} from "../orchestrator/specialist-profiles";
const root=process.cwd(),vendor=path.join(root,"vendor/firefly-skills"),skills=()=>[...scanSkills(path.join(root,"skills"),"builtin"),...scanSkills(path.join(vendor,"skills"),"builtin")];
describe("three approved Skills delivery",()=>{
 it("discovers only the approved additions with exact primary owners and preserves existing capabilities",()=>{
  const pool=skills(),owners=buildSkillOwnership(pool);expect(new Set(pool.map(s=>s.id)).size).toBe(54);
  for(const [id,primary] of [["tob-property-based-testing","implementation"],["ecc-production-audit","ops-release"],["document-reader-validation","documents-data"]]){expect(pool.find(s=>s.id===id)).toBeDefined();expect(owners.find(s=>s.skillId===id)?.primaryAgent).toBe(primary)}
  for(const id of ["diagram","knowledge-workspace"])expect(pool.some(s=>s.id===id)).toBe(true);
  for(const id of ["assessment","tutoring","differential-review","agentic-actions-auditor"])expect(pool.some(s=>s.id===id)).toBe(false);
  const profiles=createSpecialistProfiles("work",[],pool);expect(profiles).toHaveLength(12);for(const p of profiles)expect(p.allowedToolIds).not.toContain("delegate_agent");
 });
 it("ships the five PBT references and complete CC license, pinned production audit MIT and independent reader workflow",()=>{
  const pool=skills(),pbt=pool.find(s=>s.id==="tob-property-based-testing")!;expect(pbt).toBeDefined();expect(pbt.references?.sort()).toEqual(["generating.md","interpreting-failures.md","libraries.md","refactoring.md","reviewing.md"]);
  expect(fs.readFileSync(path.join(vendor,"skills/tob-property-based-testing/LICENSE"),"utf8")).toContain("Attribution-ShareAlike 4.0 International");
  expect(fs.readFileSync(path.join(vendor,"skills/ecc-production-audit/LICENSE"),"utf8")).toContain("Affaan Mustafa");
  for(const id of ["tob-property-based-testing","ecc-production-audit"]){const body=fs.readFileSync(pool.find(s=>s.id===id)!.bodyPath,"utf8");expect(body).toContain("Firefly host boundary");expect(body).toContain("specialist");expect(body).toContain("does not authorize");}
  const reader=pool.find(s=>s.id==="document-reader-validation")!,readerBody=fs.readFileSync(reader.bodyPath,"utf8");expect(readerBody).toContain("读者与目的");expect(readerBody).toContain("读者问题");expect(readerBody).toContain("未执行");expect(readerBody).toContain("主流萤");expect(reader.modes).toEqual(["work"]);
  const provenance=JSON.parse(fs.readFileSync(path.join(vendor,"license-provenance.json"),"utf8"));expect(provenance.currentDistribution.addedSkills.map((x:any)=>x.id).sort()).toEqual(["ac-documentation-writer","ac-prd","as-deprecation-and-migration","ecc-agent-security-hardening","ecc-production-audit","frontend-design","sp-receiving-code-review","tob-property-based-testing","ws-accessibility-compliance","ws-architecture-decision-records","ws-data-storytelling","ws-error-handling-patterns","ws-stride-analysis-patterns"]);
  for(const x of provenance.currentDistribution.addedSkills){expect(x.upstream.commit).toMatch(/^[0-9a-f]{40}$/);expect(x.upstream.bodySha256).toMatch(/^[0-9a-f]{64}$/);expect(x.retainedLicenseSha256).toMatch(/^[0-9a-f]{64}$/)}
 });
});
