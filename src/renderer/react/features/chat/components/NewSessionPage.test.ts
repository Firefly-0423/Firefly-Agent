// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeRain, randomGlyph, rippleIntensity } from "./CodeRain";

vi.mock("../../../i18n", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
beforeEach(() => { globalThis.IS_REACT_ACT_ENVIRONMENT = true; host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe("code rain", () => {
  it("draws only letters and digits", () => {
    let n = 0;
    const random = () => (n++ % 62) / 62;
    for (let index = 0; index < 62; index += 1) expect(randomGlyph(random)).toMatch(/^[A-Za-z0-9]$/);
  });
  it("lights a ring that travels out from the pointer and fades, and nothing at rest", () => {
    const ripple = { x: 0, y: 0, born: 0 };
    expect(rippleIntensity(100, 0, [], 500)).toBe(0);
    // After 500 ms the ring is about 160 px out: bright there, dark at the centre and far beyond.
    const onRing = rippleIntensity(160, 0, [ripple], 500);
    expect(onRing).toBeGreaterThan(0.5);
    expect(rippleIntensity(0, 0, [ripple], 500)).toBeLessThan(0.01);
    expect(rippleIntensity(400, 0, [ripple], 500)).toBeLessThan(0.01);
    // Later the same ring is fainter, and once its life is over it is gone.
    expect(rippleIntensity(320, 0, [ripple], 1000)).toBeLessThan(onRing);
    expect(rippleIntensity(600, 0, [ripple], 2000)).toBe(0);
  });
  it("is a decorative canvas that does not take the pointer", () => {
    act(() => root.render(React.createElement(CodeRain)));
    const canvas = host.querySelector("canvas")!;
    expect(canvas.getAttribute("aria-hidden")).toBe("true");
    expect(canvas.classList.contains("ff-code-rain")).toBe(true);
  });
});
