import path from "node:path";
import {it,expect} from "vitest";
import {desktopResponsesContract,desktopHistoryHelperPath} from "./desktop-memory-backend";
it("Main caps the verified GPT-5.2 limits and reserves output plus safety within the actual configured window",()=>{
 const contract=desktopResponsesContract({provider:"ChatGPT（OpenAI）",baseUrl:"https://api.openai.com/v1",model:"gpt-5.2",explicitTransport:"responses",contextWindowTokens:256000} as any);expect(contract.modelMaxOutputTokens).toBe(128000);expect(contract.budget.maxContextTokens).toBe(256000);expect(contract.budget.reservedOutputTokens).toBe(4096);expect(contract.budget.safetyMarginTokens).toBe(1024);expect(contract.budget.minRecentCompleteTurns).toBe(1);
 expect(desktopResponsesContract({provider:"ChatGPT（OpenAI）",baseUrl:"https://api.openai.com/v1",model:"gpt-5.2-2025-12-11",contextWindowTokens:999999} as any).budget.maxContextTokens).toBe(400000);
});
it.each([{model:'guessed-model'},{provider:'custom'},{baseUrl:'https://other.example/v1'},{explicitTransport:'openai'},{contextWindowTokens:NaN},{contextWindowTokens:0}])("fails closed for an unverified model or incompatible transport/configuration: %j",override=>{
 expect(()=>desktopResponsesContract({provider:"ChatGPT（OpenAI）",baseUrl:"https://api.openai.com/v1",model:"gpt-5.2",explicitTransport:"responses",contextWindowTokens:256000,...override} as any)).toThrow('MEMORY_CONTEXT_COUNTER_UNSUPPORTED');
});

it("packaged history helper uses external resources without accessing the ASAR application path",()=>{
 expect(desktopHistoryHelperPath({isPackaged:true,getAppPath:()=>{throw Error('ASAR_PATH_MUST_NOT_BE_USED')}},path.resolve('fixture','resources'))).toBe(path.resolve('fixture','resources','bin','firefly-history-read.exe'));
});
it("development history helper retains the native release output path",()=>{
 expect(desktopHistoryHelperPath({isPackaged:false,getAppPath:()=>path.resolve('fixture','repo')},path.resolve('fixture','resources'))).toBe(path.resolve('fixture','repo','native','target','release','firefly-history-read.exe'));
});
