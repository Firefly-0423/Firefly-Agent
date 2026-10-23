import {describe,expect,it,vi} from "vitest";
import {DEFAULT_DMAE_PARAMS,type DmaeState,type WorldbookEntry} from "../../rag/worldbook";
import type {EntrySnapshot,SimResult} from "../sim-types";
import {computeStats,printStats} from "./stats";

function entry(id:string,overrides:Partial<WorldbookEntry>={}):WorldbookEntry{
 return{id,keywords:[],content:"",priority:1,permanent:false,enabled:true,intrinsicValue:10,linkTriggers:[],...overrides};
}
function snap(entryId:string,activation:number,state:DmaeState):EntrySnapshot{
 return{entryId,intrinsicValue:10,priority:1,activation,userSilence:0,modelSilence:0,state,userHit:false,modelHit:false,recentUserHits:[]};
}
function result():SimResult{
 const entries=[entry("e1"),entry("perm",{permanent:true}),entry("e3",{intrinsicValue:20})];
 const snapshots=[
  [snap("e1",10,"Active"),snap("perm",99,"Active"),snap("e3",0,"Dormant")],
  [snap("e1",20,"Active"),snap("perm",99,"Active"),snap("e3",5,"Active")],
  [snap("e1",0,"Dormant"),snap("perm",99,"Active"),snap("e3",5,"Active")],
 ];
 const base={scenario:"synthetic",params:{...DEFAULT_DMAE_PARAMS},entries,rounds:[],snapshots};
 return{...base,stats:computeStats(base)};
}

describe("computeStats",()=>{
 it("computes occupancy, average active runs and per-round ranking",()=>{
  const stats=result().stats;
  expect(stats.totalRounds).toBe(3);
  expect(stats.promptOccupancy.get("e1")).toBeCloseTo(2/3);
  expect(stats.promptOccupancy.get("perm")).toBe(1);
  expect(stats.promptOccupancy.get("e3")).toBeCloseTo(2/3);
  expect(stats.avgActiveLife.get("e1")).toBe(2);
  expect(stats.avgActiveLife.get("perm")).toBe(3);
  expect(stats.avgActiveLife.get("e3")).toBe(2);
  expect(stats.promptRanking.get(0)).toEqual(["e1"]);
  expect(stats.promptRanking.get(1)).toEqual(["e1","e3"]);
  expect(stats.promptRanking.get(2)).toEqual(["e3"]);
 });
 it("excludes permanent and zero-activation entries from the ranking",()=>{
  const stats=result().stats;
  expect(stats.promptRanking.get(0)).not.toContain("perm");
  expect(stats.promptRanking.get(0)).not.toContain("e3");
 });
 it("returns zeroes when there are no snapshots",()=>{
  const base={scenario:"empty",params:{...DEFAULT_DMAE_PARAMS},entries:[entry("e1"),entry("e2",{permanent:true})],rounds:[],snapshots:[]};
  const stats=computeStats(base);
  expect(stats.totalRounds).toBe(0);
  expect(stats.promptOccupancy.get("e1")).toBe(0);
  expect(stats.avgActiveLife.get("e1")).toBe(0);
  expect(stats.promptRanking.size).toBe(0);
 });
 it("uses the first entry for duplicate ids, matching Array.find semantics",()=>{
  const entries=[entry("dup",{permanent:true}),entry("dup")];
  const snapshots=[[snap("dup",50,"Active")]];
  const stats=computeStats({scenario:"dup",params:{...DEFAULT_DMAE_PARAMS},entries,rounds:[],snapshots});
  expect(stats.promptRanking.get(0)).toEqual([]);
 });
});

describe("printStats",()=>{
 it("prints dynamic entries, totals and sampled rankings",()=>{
  const log=vi.spyOn(console,"log").mockImplementation(()=>{});
  try{
   printStats(result());
   const lines=log.mock.calls.map(call=>String(call[0]));
   expect(lines.some(line=>line.includes("总轮数: 3"))).toBe(true);
   expect(lines.some(line=>line.includes("e1")&&line.includes("66.7%"))).toBe(true);
   expect(lines.some(line=>line.includes("e3")&&line.includes("2.00"))).toBe(true);
   expect(lines.some(line=>line.includes("R  0: 1.e1"))).toBe(true);
   expect(lines.some(line=>line.includes("perm"))).toBe(false);
  }finally{log.mockRestore()}
 });
});
