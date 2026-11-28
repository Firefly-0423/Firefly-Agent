import {describe,expect,it} from "vitest";
import type {SocialAtom,SocialAtomStatus,SocialAtomType} from "./types";
import {rankSocialAtoms} from "./retrieval";

const NOW=Date.UTC(2026,0,31,12,0,0);
let sequence=0;
function atom(content:string,overrides:Partial<SocialAtom>={}):SocialAtom{
 sequence+=1;
 return{
  id:`atom-${sequence}`,
  conversationId:"conversation-1",
  type:"long_term" as SocialAtomType,
  content,
  evidenceTurnId:"turn-1",
  evidenceQuote:content,
  createdAt:NOW,
  status:"active" as SocialAtomStatus,
  ...overrides,
 };
}

describe("rankSocialAtoms",()=>{
 it("returns nothing for an empty corpus",()=>{
  expect(rankSocialAtoms("coffee",[],{now:NOW})).toEqual([]);
 });
 it("ranks lexically matching atoms and drops non-matches",()=>{
  const coffee=atom("I drink coffee every morning");
  const tea=atom("Tea is fine");
  expect(rankSocialAtoms("coffee",[coffee,tea],{now:NOW}).map(a=>a.id)).toEqual([coffee.id]);
 });
 it("filters inactive and expired atoms before scoring",()=>{
  const active=atom("coffee");
  const superseded=atom("coffee",{status:"superseded"});
  const expired=atom("coffee",{expiresAt:NOW});
  const future=atom("coffee",{expiresAt:NOW+1});
  expect(rankSocialAtoms("coffee",[superseded,expired,active,future],{now:NOW}).map(a=>a.id)).toEqual([active.id,future.id]);
 });
 it("honors the limit, including zero and negative limits",()=>{
  const atoms=[atom("coffee one"),atom("coffee two"),atom("coffee three")];
  expect(rankSocialAtoms("coffee",atoms,{now:NOW,limit:2})).toHaveLength(2);
  expect(rankSocialAtoms("coffee",atoms,{now:NOW,limit:0})).toEqual([]);
  expect(rankSocialAtoms("coffee",atoms,{now:NOW,limit:-1})).toEqual([]);
 });
 it("defaults the limit to five",()=>{
  const atoms=Array.from({length:8},(_,index)=>atom(`coffee ${index}`));
  expect(rankSocialAtoms("coffee",atoms,{now:NOW})).toHaveLength(5);
 });
 it("prefers newer atoms when lexical scores tie",()=>{
  const older=atom("coffee",{createdAt:NOW-60*86_400_000});
  const newer=atom("coffee",{createdAt:NOW});
  expect(rankSocialAtoms("coffee",[older,newer],{now:NOW}).map(a=>a.id)).toEqual([newer.id,older.id]);
 });
 it("includes open loops even without a lexical match",()=>{
  const loop=atom("did you finish the report",{type:"open_loop"});
  const ordinary=atom("did you finish the report",{type:"long_term"});
  expect(rankSocialAtoms("zzz",[ordinary,loop],{now:NOW}).map(a=>a.id)).toEqual([loop.id]);
 });
 it("scores a future creation time as fully recent without throwing",()=>{
  const future=atom("coffee",{createdAt:NOW+86_400_000});
  expect(rankSocialAtoms("coffee",[future],{now:NOW})).toHaveLength(1);
 });
 it("treats blank queries as having no lexical terms",()=>{
  const ordinary=atom("coffee");
  const loop=atom("open question",{type:"open_loop"});
  expect(rankSocialAtoms("   ",[ordinary,loop],{now:NOW}).map(a=>a.id)).toEqual([loop.id]);
 });
 it("supports Chinese content",()=>{
  const chinese=atom("我喜欢喝咖啡");
  const other=atom("今天天气不错");
  expect(rankSocialAtoms("咖啡",[other,chinese],{now:NOW})[0]?.id).toBe(chinese.id);
 });
});
