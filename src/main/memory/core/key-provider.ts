/** Main-only key capability. Never serialize a key into shared DTOs. */
export interface KeyProtection {protect(plaintext:Uint8Array):Promise<Uint8Array>;unprotect(blob:Uint8Array):Promise<Uint8Array>}
export interface OpenLease {assertHeld():void;release():Promise<void>;onLost(callback:()=>void):()=>void}
export interface MemoryKeyHandle {readonly keyVersion:1;releaseOpenLock():Promise<void>;destroy():Promise<void>}
const handles=new WeakMap<object,{bytes:Buffer;lease:OpenLease;destroyed:boolean}>();
export function createMemoryKeyHandle(bytes:Uint8Array,lease:OpenLease):MemoryKeyHandle{
 if(bytes.length!==32)throw new Error("MEMORY_KEY_INVALID");
 const state={bytes:Buffer.from(bytes),lease,destroyed:false};
 const handle=Object.freeze({keyVersion:1 as const,async releaseOpenLock(){await state.lease.release()},async destroy(){if(!state.destroyed){state.destroyed=true;state.bytes.fill(0)}await state.lease.release()}});
 handles.set(handle,state);return handle;
}
export function copyMemoryKeyBytes(handle:MemoryKeyHandle):Buffer{
 const state=handles.get(handle);
 if(!state||state.destroyed)throw new Error("MEMORY_KEY_HANDLE_INVALID");
 return Buffer.from(state.bytes);
}

export function assertMemoryKeyOpenLease(handle:MemoryKeyHandle):void{
 const state=handles.get(handle);
 if(!state||state.destroyed)throw new Error("MEMORY_KEY_HANDLE_INVALID");
 state.lease.assertHeld();
}