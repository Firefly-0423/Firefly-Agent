/** Stable request representation; rejects non-JSON values and excessive nesting. */
export function canonicalJson(value:unknown,depth=0):string{
 if(depth>64)throw new Error("MEMORY_INPUT_INVALID");
 if(value===null)return "null";
 if(typeof value==="string"||typeof value==="boolean")return JSON.stringify(value);
 if(typeof value==="number"&&Number.isFinite(value))return JSON.stringify(value);
 if(Array.isArray(value)){for(let i=0;i<value.length;i++)if(!Object.prototype.hasOwnProperty.call(value,i))throw new Error("MEMORY_INPUT_INVALID");return "["+value.map(v=>canonicalJson(v,depth+1)).join(",")+"]";}
 if(typeof value==="object"&&value&&Object.getPrototypeOf(value)===Object.prototype){
  return "{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+canonicalJson((value as Record<string,unknown>)[k],depth+1)).join(",")+"}";
 }
 throw new Error("MEMORY_INPUT_INVALID");
}
