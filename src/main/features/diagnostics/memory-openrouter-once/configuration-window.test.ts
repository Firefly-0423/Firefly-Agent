import { describe, expect, it } from "vitest";
import { acceptConfigurationMessage, configurationPage } from "./configuration-window";
describe("narrow credential form boundary",()=>{
 it("admits only owning main frame and the frozen page URL",()=>{const frame={url:"data:text/html,synthetic"};const owner={mainFrame:frame};const event={sender:owner,senderFrame:frame};const payload={key:"SYNTHETIC-KEY-ONLY",balanceOnly:true};const accept=(key:unknown,balance:boolean)=>key===payload.key&&balance;
 expect(acceptConfigurationMessage(event,owner,frame.url,payload,accept)).toEqual({ok:true});
 for(const e of [{sender:{},senderFrame:frame},{sender:owner,senderFrame:{url:frame.url}},{sender:owner,senderFrame:null}])expect(acceptConfigurationMessage(e,owner,frame.url,payload,accept)).toEqual({ok:false});
 expect(acceptConfigurationMessage(event,owner,"data:other",payload,accept)).toEqual({ok:false});
 });
 it("never accepts arbitrary profile fields or a false billing acknowledgement",()=>{const frame={url:"data:test"},owner={mainFrame:frame},event={sender:owner,senderFrame:frame};const accept=()=>true;
 for(const payload of [null,{}, {key:"SYNTHETIC-KEY-ONLY",balanceOnly:false},{key:"SYNTHETIC-KEY-ONLY",balanceOnly:true,model:"other"},{key:"x".repeat(513),balanceOnly:true}])expect(acceptConfigurationMessage(event,owner,frame.url,payload,accept)).toEqual({ok:false});
 });
 it("shows fixed destination/model/USD budget and no external content or script",()=>{const page=configurationPage();expect(page).toContain("https://openrouter.ai/api/v1/chat/completions");expect(page).toContain("deepseek/deepseek-v4.1-flash");expect(page).toContain("USD 1");expect(page).toContain('type="password"');expect(page).toContain("connect-src 'none'");expect(page).toContain("script-src 'none'");expect(page).not.toContain("<script");});
});
