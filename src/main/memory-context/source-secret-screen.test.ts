import { expect, it } from "vitest";
import { assertContextSecretFree } from "./source-secret-screen";

const maskedGhStatus = "github.com\n  - Active account: true\n  - Token: gho_" + "*".repeat(36) + "\n  - Token scopes: 'repo'\n";
it.each([
 maskedGhStatus, "token: ********", 'api_key="********"', "password: '********'", "密钥：********",
 {token:"********", nested:{auth_token:"gho_"+"*".repeat(36)}},
 JSON.stringify({stdout:maskedGhStatus,exitCode:1,errorCode:"E_SHELL_EXIT"}),
 JSON.stringify({role:"tool",content:JSON.stringify({output:JSON.stringify({stdout:maskedGhStatus})})}),
])("allows only fully masked credential placeholders, including serialized tool results %#", value=>{
 expect(()=>assertContextSecretFree(value)).not.toThrow();
});
it.each([
 "token: gho_CANARY********", "token: ********CANARY", "token: ****-CANARY", "token: gho_***CANARY***",
 'token: "******** CANARY"', 'token: "********" + CANARY', "token: ********.CANARY",
 "token: ********\u200bCANARY", "token: ****\\nCANARY", "token: gho_***\\u0041",
 "password: ********;SYNTHETIC_ONLY_CANARY", 'token: "********", "SYNTHETIC_ONLY_CANARY"',
 "token: ********}SYNTHETIC_ONLY_CANARY", "token: ********]SYNTHETIC_ONLY_CANARY",
 {token:"gho_CANARY********"}, {token:"******** CANARY"}, {token:"********\u0000CANARY"},
 JSON.stringify({stdout:'token: "******** CANARY"'}),
 JSON.stringify({stdout:maskedGhStatus,access_token:"SYNTHETIC_ONLY_CANARY"}),
 '{"token":123456}',
 '{"api_key=SYNTHETIC_ONLY_CANARY":"ok"}',
 '{"ghp_abcdefghijklmnop123456":"ok"}',
 '{"\\u0061pi_key=SYNTHETIC_ONLY_CANARY":"ok"}',
 maskedGhStatus+"api_key=SYNTHETIC_ONLY_CANARY", "token: ****; password=SYNTHETIC_ONLY_CANARY",
])("rejects partial masks, disguised values, and secrets adjacent to placeholders %#",value=>{
 expect(()=>assertContextSecretFree(value)).toThrow(/^MEMORY_CONTEXT_TRANSCRIPT_SECRET$/);
});
it.each([
 '{"token":"SYNTHETIC_ONLY_CANARY","token":"********"}',
 '{"token":"SYNTHETIC_ONLY_CANARY","\\u0074oken":"********"}',
])("rejects duplicate JSON keys before a later mask can hide an earlier secret %#",value=>{
 expect(()=>assertContextSecretFree(value)).toThrow(/^MEMORY_CONTEXT_INPUT_INVALID$/);
});
it.each([
 "Explain the api_key field and password validation", "The refresh_token property is optional",
 "请解释密码字段如何校验，不要保存密钥", "x".repeat(120000),
 {name:"api_key",type:"string",description:"API key field"},
 {password:"",access_token:null},
])("allows code/schema field discussion without a credential value %#",value=>expect(()=>assertContextSecretFree(value)).not.toThrow());
it.each([
 "api_key=SECRET_CANARY_1234567890", "refresh_token=REVIEW_SECRET_CANARY",
 "My passphrase is SYNTHETIC_ONLY_SECRET", "密码：SYNTHETIC_ONLY_SECRET",
 "Authorization: Bearer SYNTHETIC_ONLY_TOKEN", "sk-abcdefghijklmnopqrstuvwxyz123456",
 {rawAssistant:{nested:{api_key:"SYNTHETIC_ONLY_SECRET"}}},
 {toolCalls:[{arguments:'{"refresh_token":"SYNTHETIC_ONLY_SECRET"}'}]},
 "-----BEGIN PRIVATE KEY-----\nSYNTHETIC_ONLY_SECRET",
])("rejects credential values anywhere with a reason-only error %#",value=>{
 expect(()=>assertContextSecretFree(value)).toThrow(/^MEMORY_CONTEXT_TRANSCRIPT_SECRET$/);
});
it.each(["type Login = { api_key: string; password: string }","interface Login { access_token: string; password: string }","The token is a unit of text."])("allows explicit schema type declarations and ordinary token discussion: %s",value=>expect(()=>assertContextSecretFree(value)).not.toThrow());
