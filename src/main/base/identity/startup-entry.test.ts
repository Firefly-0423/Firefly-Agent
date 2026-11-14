import { describe, expect, it, vi } from "vitest";
import { diagnosticSwitchesAllowed, dispatchMainEntry } from "./startup-entry";
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

describe("diagnostic switches in installed builds", () => {
  it("allows diagnostic switches only in development builds", () => {
    expect(diagnosticSwitchesAllowed(false)).toBe(true);
    expect(diagnosticSwitchesAllowed(true)).toBe(false);
  });

  it.each([
    { name: "online-once", diagnostic: true, openrouter: false },
    { name: "openrouter-once", diagnostic: false, openrouter: true },
    { name: "both switches", diagnostic: true, openrouter: true },
  ])("starts normally and reports the ignored switch when an installed build gets $name", ({ diagnostic, openrouter }) => {
    const ordinary = vi.fn(), diagnosticPath = vi.fn(), openrouterPath = vi.fn(), ignored = vi.fn();
    dispatchMainEntry(diagnostic, { ordinary, diagnostic: diagnosticPath, openrouter: openrouterPath, ignored }, openrouter, false);
    expect(ordinary).toHaveBeenCalledOnce();
    expect(diagnosticPath).not.toHaveBeenCalled();
    expect(openrouterPath).not.toHaveBeenCalled();
    expect(ignored).toHaveBeenCalledOnce();
  });

  it("does not report anything when an installed build starts without switches", () => {
    const ordinary = vi.fn(), ignored = vi.fn();
    dispatchMainEntry(false, { ordinary, diagnostic: vi.fn(), ignored }, false, false);
    expect(ordinary).toHaveBeenCalledOnce();
    expect(ignored).not.toHaveBeenCalled();
  });
});
