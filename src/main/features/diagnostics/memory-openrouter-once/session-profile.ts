/** A user-entered credential in memory only; no settings-store dependency. */
export interface SessionProfile { id:string; provider:"OpenRouter"; model:"deepseek/deepseek-v4.1-flash"; baseUrl:"https://openrouter.ai/api/v1"; explicitTransport:"openai"; apiKey:string; }
export function validKey(value:unknown):value is string { return typeof value==="string" && /^[\x21-\x7e]{16,512}$/.test(value); }
export function createSessionProfile(key:unknown,id:string):SessionProfile {
 if(!validKey(key))throw new Error("KEY_REFUSED");
 if(typeof id!=="string"||id.length===0||id.length>128)throw new Error("PROFILE_REFUSED");
 return {id,provider:"OpenRouter",model:"deepseek/deepseek-v4.1-flash",baseUrl:"https://openrouter.ai/api/v1",explicitTransport:"openai",apiKey:key};
}
