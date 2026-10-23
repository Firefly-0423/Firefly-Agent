import { describe, expect, it, vi } from "vitest";
import { createNativeProbeEntry } from "./native-entry";
import { buildTrayMenuTemplate } from "../windows/tray";
vi.mock("electron",()=>({Menu:{},Tray:class{},app:{getAppPath:()=>"E:/fake"},nativeImage:{}}));
const completed={status:"completed" as const,attempts:2,reservedMicroCny:4198400,upperMicroCny:720,usage:[{promptTokens:100,completionTokens:20,totalTokens:120,upperMicroCny:360}]};
describe("native one-time entry",()=>{
 it("passes only a saved ID to Main runner and displays only numeric sanitized receipt",async()=>{
  const show=vi.fn().mockResolvedValueOnce({response:1}).mockResolvedValueOnce({response:0});
  const runner={start:vi.fn(async()=>completed),cancel:vi.fn()};
  const entry=createNativeProbeEntry({listProfileIds:()=>["secret-id-one","secret-id-two"],runner,show});
  await entry.run();expect(runner.start).toHaveBeenCalledWith("secret-id-two");
  const dialogs=JSON.stringify(show.mock.calls);expect(dialogs).not.toContain("secret-id");expect(dialogs).toContain("720");expect(dialogs).not.toContain("choices");
 });
 it("coalesces duplicate UI actions and handles cancel without fetch",async()=>{
  const show=vi.fn(async()=>({response:1}));const runner={start:vi.fn(),cancel:vi.fn()};
  const entry=createNativeProbeEntry({listProfileIds:()=>["saved"],runner,show});
  const p=entry.run();expect(entry.run()).toBe(p);await p;expect(runner.start).not.toHaveBeenCalled();expect(runner.cancel).toHaveBeenCalledOnce();
 });
 it("refuses an empty cache and does not leak thrown native dialog errors",async()=>{
  for(const ids of [[],["saved"]]) {
   const show=vi.fn(async()=>{throw new Error("FAKE-SECRET")});const runner={start:vi.fn(),cancel:vi.fn()};
   const entry=createNativeProbeEntry({listProfileIds:()=>ids,runner,show});await expect(entry.run()).resolves.toBeUndefined();expect(runner.start).not.toHaveBeenCalled();
  }
 });
 it("adds explicit native run/cancel menu callbacks only when injected",()=>{
  const run=vi.fn(),cancel=vi.fn();const template=buildTrayMenuTemplate({requestActivation:vi.fn(),togglePetWindow:vi.fn(),quit:vi.fn(),memoryOnlineOnce:{run,cancel}});
  const start=template.find(i=>i.label==="记忆 H：一次性在线测试（≤¥5）")!;
  const stop=template.find(i=>i.label==="取消记忆 H 在线测试")!;
  (start.click as ()=>void)();(stop.click as ()=>void)();expect(run).toHaveBeenCalledOnce();expect(cancel).toHaveBeenCalledOnce();
  expect(buildTrayMenuTemplate({requestActivation:vi.fn(),togglePetWindow:vi.fn(),quit:vi.fn()}).some(i=>i.label?.includes("在线测试"))).toBe(false);
 });
});
