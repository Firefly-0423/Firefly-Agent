import {describe,expect,it,vi} from "vitest";
import {DEFAULT_DMAE_PARAMS,type DmaeState,type WorldbookEntry} from "../../rag/worldbook";
import type {EntrySnapshot,SimResult} from "../sim-types";
import {renderLineCharts} from "./ascii-line-chart";

function entry(id:string,permanent=false):WorldbookEntry{
 return{id,keywords:[],content:"",priority:1,permanent,enabled:true,intrinsicValue:20,linkTriggers:[]};
}
function snap(entryId:string,activation:number,state:DmaeState):EntrySnapshot{
 return{entryId,intrinsicValue:20,priority:1,activation,userSilence:0,modelSilence:0,state,userHit:false,modelHit:false,recentUserHits:[]};
}
function result():SimResult{
 const entries=[entry("dynamic"),entry("always",true),entry("no-data")];
 const snapshots=[[snap("dynamic",50,"Active")],[snap("dynamic",10,"Dormant")]];
 return{scenario:"chart",params:{...DEFAULT_DMAE_PARAMS,maxScore:100,promptThreshold:30},entries,rounds:[],snapshots,stats:{
  promptOccupancy:new Map(),avgActiveLife:new Map(),promptRanking:new Map(),totalRounds:2,
 }};
}

describe("renderLineCharts",()=>{
 it("renders state glyphs, threshold markers and axis labels",()=>{
  const log=vi.spyOn(console,"log").mockImplementation(()=>{});
  try{
   renderLineCharts(result());
   const lines=log.mock.calls.map(call=>String(call[0]));
   expect(lines[0]).toContain("ASCII 折线图");
   expect(lines.some(line=>line.includes("dynamic  (I=20)"))).toBe(true);
   expect(lines.some(line=>line.includes("█"))).toBe(true);
   expect(lines.some(line=>line.includes("▒"))).toBe(true);
   expect(lines.some(line=>line.includes("threshold(30)"))).toBe(true);
   expect(lines.some(line=>line.includes("I值(20)"))).toBe(true);
   expect(lines.some(line=>line.startsWith("    0-")&&line.endsWith("1"))).toBe(true);
  }finally{log.mockRestore()}
 });
 it("reports permanent entries without plotting them",()=>{
  const log=vi.spyOn(console,"log").mockImplementation(()=>{});
  try{
   renderLineCharts(result());
   const lines=log.mock.calls.map(call=>String(call[0]));
   expect(lines.some(line=>line.includes("[permanent] always"))).toBe(true);
   expect(lines.some(line=>line.includes("always  (I="))).toBe(false);
  }finally{log.mockRestore()}
 });
 it("prints a no-data marker for entries missing from every snapshot",()=>{
  const log=vi.spyOn(console,"log").mockImplementation(()=>{});
  try{
   renderLineCharts(result());
   const lines=log.mock.calls.map(call=>String(call[0]));
   expect(lines.some(line=>line.includes("no-data  (I=20)"))).toBe(true);
   expect(lines.some(line=>line.trim()==="(no data)")).toBe(true);
  }finally{log.mockRestore()}
 });
 it("does not draw points outside the chart bounds",()=>{
  const value=result();
  value.snapshots=[[snap("dynamic",200,"Active")]];
  const log=vi.spyOn(console,"log").mockImplementation(()=>{});
  try{
   expect(()=>renderLineCharts(value)).not.toThrow();
   const lines=log.mock.calls.map(call=>String(call[0]));
   expect(lines.some(line=>line.includes("|")&&line.includes("█"))).toBe(false);
  }finally{log.mockRestore()}
 });
});
