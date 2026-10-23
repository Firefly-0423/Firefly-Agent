import {createHash} from "node:crypto";
/** Service identity is distinct from a reusable protocol adapter's capability ID. */
export function requestProviderIdentity(baseUrl:string):string {
 let url:URL;try{url=new URL(baseUrl)}catch{throw Error("MEMORY_CONTEXT_COUNTER_UNSUPPORTED")}
 const normalized=url.origin+url.pathname.replace(/\/+$/,"");
 if(normalized==="https://api.openai.com/v1"&&!url.search&&!url.hash&&!url.username&&!url.password)return "openai";
 if(normalized==="https://openrouter.ai/api/v1"&&!url.search&&!url.hash&&!url.username&&!url.password)return "openrouter";
 return "configured-"+createHash("sha256").update(baseUrl).digest("hex").slice(0,24);
}
