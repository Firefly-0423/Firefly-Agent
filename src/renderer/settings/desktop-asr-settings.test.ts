// @vitest-environment jsdom
import fs from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { bindDesktopAsrSettings } from "./desktop-asr-settings";
const html=fs.readFileSync("src/renderer/settings/index.html","utf8");
beforeEach(()=>{document.body.innerHTML=html;});
const form=()=>document.querySelector<HTMLFormElement>('#desktop-asr-form')!;
const field=(name:string)=>form().elements.namedItem(name) as HTMLInputElement;
it("offers only implemented providers, keeps local explicitly unavailable and masks credentials",()=>{
 expect(document.querySelector('[data-section="asr"]')).not.toBeNull(); expect(form()).not.toBeNull();
 const engine=field("asrEngine") as unknown as HTMLSelectElement;
 expect([...engine.options].filter(x=>!x.disabled).map(x=>x.value)).toEqual(["off","mossland","aliyun"]);
 expect(engine.querySelector<HTMLOptionElement>('[value="local"]')?.disabled).toBe(true);
 for(const key of ["asrMosslandKey","asrAliyunAccessKeyId","asrAliyunAccessKeySecret"]) expect(field(key).type).toBe("password");
 expect(form().textContent).not.toMatch(/TTS|VAD|通话/);
 expect(form().querySelector('select[name="asrLanguage"]')).toBeNull();
});
it("loads shared values and saves only an explicit ASR form submission",async()=>{
 const saves:any[]=[];const saved={asrEngine:"mossland",asrMosslandKey:"fixture-old",asrAliyunAppKey:"fixture-app",asrAliyunAccessKeyId:"fixture-id",asrAliyunAccessKeySecret:"fixture-secret",asrLanguage:"en"};
 await bindDesktopAsrSettings(document,{getGeneral:async()=>saved,saveGeneral:async patch=>{saves.push(patch);return patch;}} as never);
 expect(field("asrMosslandKey").value).toBe("fixture-old"); expect(saves).toEqual([]);
 field("asrMosslandKey").value=" fixture-new ";form().dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));await vi.waitFor(()=>expect(saves).toHaveLength(1));
 expect(saves[0]).toEqual({...saved,asrMosslandKey:"fixture-new"});
});
it("keeps existing local config visible without silently enabling an unimplemented service",async()=>{
 const save=vi.fn();await bindDesktopAsrSettings(document,{getGeneral:async()=>({asrEngine:"local"}),saveGeneral:save} as never);
 expect(field("asrEngine").value).toBe("local");form().dispatchEvent(new Event("submit",{cancelable:true}));expect(save).not.toHaveBeenCalled();expect(form().querySelector('[role="status"]')?.textContent).toContain("尚未实现");
});
it("reports load and save failures visibly without leaking provider errors",async()=>{
 await bindDesktopAsrSettings(document,{getGeneral:async()=>{throw new Error("secret fixture");}} as never);
 expect(form().querySelector<HTMLButtonElement>('[type="submit"]')!.disabled).toBe(true); expect(form().textContent).toContain("读取失败");expect(form().textContent).not.toContain("secret fixture");
 await bindDesktopAsrSettings(document,{getGeneral:async()=>({asrEngine:"off"}),saveGeneral:async()=>{throw new Error("secret fixture");}} as never);
 form().dispatchEvent(new Event("submit",{cancelable:true})); await vi.waitFor(()=>expect(form().textContent).toContain("保存失败"));expect(form().textContent).not.toContain("secret fixture");
});
it("locks controls during initial load and saving to prevent overwritten credential edits",async()=>{
 let load!: (value:any)=>void;let save!: (value:any)=>void;
 const loading=bindDesktopAsrSettings(document,{getGeneral:()=>new Promise(r=>load=r),saveGeneral:()=>new Promise(r=>save=r)} as never);
 expect(field("asrEngine").disabled).toBe(true);expect(field("asrMosslandKey").disabled).toBe(true);
 load({asrEngine:"off"});await loading;expect(field("asrEngine").disabled).toBe(false);
 form().dispatchEvent(new Event("submit",{cancelable:true}));expect(field("asrMosslandKey").disabled).toBe(true);
 save({asrEngine:"off"});await vi.waitFor(()=>expect(field("asrEngine").disabled).toBe(false));
});
