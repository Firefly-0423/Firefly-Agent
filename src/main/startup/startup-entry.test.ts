import { describe, expect, it, vi } from "vitest";
import { dispatchMainEntry } from "./startup-entry";
describe("actual Main startup dispatch before any ordinary preflight",()=>{
 it("routes diagnostic startup without loading normal identity/core/background",()=>{
  const ordinary=vi.fn(()=>{throw new Error("NORMAL_FORBIDDEN");}),diagnostic=vi.fn();
  dispatchMainEntry(true,{ordinary,diagnostic});expect(diagnostic).toHaveBeenCalledOnce();expect(ordinary).not.toHaveBeenCalled();
 });
 it("preserves ordinary startup when diagnostic switch absent",()=>{
  const ordinary=vi.fn(),diagnostic=vi.fn();dispatchMainEntry(false,{ordinary,diagnostic});expect(ordinary).toHaveBeenCalledOnce();expect(diagnostic).not.toHaveBeenCalled();
 });
});

describe("OpenRouter diagnostic startup",()=>{
 it("selects the USD entry without ordinary or legacy configuration startup",()=>{const ordinary=vi.fn(),diagnostic=vi.fn(),openrouter=vi.fn();dispatchMainEntry(false,{ordinary,diagnostic,openrouter},true);expect(openrouter).toHaveBeenCalledOnce();expect(ordinary).not.toHaveBeenCalled();expect(diagnostic).not.toHaveBeenCalled();});
 it("refuses conflicting diagnostic flags",()=>{const ordinary=vi.fn(),diagnostic=vi.fn(),openrouter=vi.fn();expect(()=>dispatchMainEntry(true,{ordinary,diagnostic,openrouter},true)).toThrow("DIAGNOSTIC_MODE_CONFLICT");expect(ordinary).not.toHaveBeenCalled();expect(diagnostic).not.toHaveBeenCalled();expect(openrouter).not.toHaveBeenCalled();});
});
