import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({read:vi.fn(),stat:vi.fn(),exists:vi.fn(),write:vi.fn(),dir:vi.fn()}));
vi.mock("node:fs",()=>({default:{readFileSync:mocks.read,statSync:mocks.stat,existsSync:mocks.exists,writeFileSync:mocks.write,mkdirSync:mocks.dir}}));
vi.mock("../settings-store",()=>({getSettingsPath:()=>"E:/synthetic/cache-models.json"}));
vi.mock("../logger",()=>({logger:{info:vi.fn(),warn:vi.fn()},LogTag:{Runtime:"runtime"}}));
beforeEach(()=>{vi.resetModules();vi.clearAllMocks();});
describe("Main cache-only saved-profile lookup",()=>{
 it("does not cold-read settings, stat the file, or fall back to a default profile",async()=>{
  const m=await import("./model-settings");
  expect(m.getCachedSavedModelProfile("missing")).toBeUndefined();expect(m.listCachedSavedModelProfileIds()).toEqual([]);
  expect(mocks.read).not.toHaveBeenCalled();expect(mocks.stat).not.toHaveBeenCalled();expect(mocks.exists).not.toHaveBeenCalled();
 });
 it("uses only a loaded synthetic cache, strict ID and a detached narrow profile snapshot",async()=>{
  const m=await import("./model-settings");
  mocks.stat.mockReturnValue({size:100});mocks.exists.mockReturnValue(true);
  mocks.read.mockReturnValue(JSON.stringify({schemaVersion:2,provider:"DeepSeek（深度求索）",modelProfiles:[{id:"saved-id",provider:"DeepSeek（深度求索）",model:"deepseek-flash",baseUrl:"https://api.deepseek.com",apiKey:"FAKE-KEY"}],defaultModelProfileId:"saved-id"}));
  m.loadModelSettings();vi.clearAllMocks();
  expect(m.listCachedSavedModelProfileIds()).toEqual(["saved-id"]);expect(m.getCachedSavedModelProfile("other")).toBeUndefined();
  const profile=m.getCachedSavedModelProfile("saved-id")!;expect(profile.apiKey).toBe("FAKE-KEY");profile.apiKey="changed";
  expect(m.getCachedSavedModelProfile("saved-id")!.apiKey).toBe("FAKE-KEY");
  expect(mocks.read).not.toHaveBeenCalled();expect(mocks.stat).not.toHaveBeenCalled();
 });
 it("prepares existing Main source read-only only on explicit preparation, using the existing loader",async()=>{
  const m=await import("./model-settings");
  expect(mocks.read).not.toHaveBeenCalled();
  mocks.stat.mockReturnValue({size:100});mocks.exists.mockReturnValue(true);mocks.read.mockReturnValue(JSON.stringify({schemaVersion:2,modelProfiles:[{id:"saved",provider:"DeepSeek（深度求索）",baseUrl:"https://api.deepseek.com",model:"deepseek-flash",apiKey:"FAKE-KEY"}]}));
  expect(m.prepareReadOnlyDiagnosticModelCache({kind:"production",applicationName:"Firefly",appData:"E:/fake-source",userData:"E:/fake-source/Firefly",sessionData:"E:/fake-source/Firefly",logs:"E:/fake-source/Firefly/logs"})).toBe(true);
  expect(mocks.read).toHaveBeenCalledWith(expect.stringMatching(/fake-source.*Firefly.*model-settings\.json/),"utf8");
  expect(m.getCachedSavedModelProfile("saved")!.apiKey).toBe("FAKE-KEY");
  expect(()=>m.saveModelSettings({model:"changed"})).toThrow("DIAGNOSTIC_READ_ONLY");expect(mocks.write).not.toHaveBeenCalled();expect(mocks.dir).not.toHaveBeenCalled();
 });
 it("refuses nonproduction sources and cannot refresh diagnostic credentials",async()=>{
  const m=await import("./model-settings");
  expect(()=>m.prepareReadOnlyDiagnosticModelCache({kind:"smoke",applicationName:"fake",appData:"E:/fake",userData:"E:/fake",sessionData:"E:/fake",logs:"E:/fake",isolationRoot:"E:/fake"})).toThrow("DIAGNOSTIC_SOURCE_REFUSED");
  expect(mocks.read).not.toHaveBeenCalled();
 });

});
