// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { bindReasoningLevels, readReasoningLevels, writeReasoningLevels } from "./reasoning-levels";

function mount() {
  document.body.innerHTML = `
    <input id="reasoning-levels-auto" type="checkbox" checked />
    <div id="reasoning-levels-options">
      ${["minimal", "low", "medium", "high", "xhigh", "max"].map((e) => `<input type="checkbox" data-effort="${e}" />`).join("")}
      <input id="reasoning-levels-off" type="checkbox" />
    </div>`;
  bindReasoningLevels();
}
const auto = () => document.querySelector<HTMLInputElement>("#reasoning-levels-auto")!;
const box = (effort: string) => document.querySelector<HTMLInputElement>(`[data-effort="${effort}"]`)!;

describe("reasoning levels form", () => {
  beforeEach(mount);

  it("is 'not declared' while automatic, and the options are locked", () => {
    expect(readReasoningLevels()).toBeUndefined();
    expect(box("high").disabled).toBe(true);
    expect(document.querySelector("#reasoning-levels-options")!.classList.contains("is-locked")).toBe(true);
  });

  it("turning automatic off unlocks the options and starts from low/medium/high", () => {
    auto().checked = false;
    auto().dispatchEvent(new Event("change"));
    expect(box("high").disabled).toBe(false);
    expect(readReasoningLevels()).toEqual({ efforts: ["low", "medium", "high"] });
  });

  it("does not overwrite a selection the user already made", () => {
    writeReasoningLevels({ efforts: ["xhigh", "max"], allowOff: true });
    expect(readReasoningLevels()).toEqual({ efforts: ["xhigh", "max"], allowOff: true });
    auto().checked = true;
    auto().dispatchEvent(new Event("change"));
    auto().checked = false;
    auto().dispatchEvent(new Event("change"));
    expect(readReasoningLevels()).toEqual({ efforts: ["xhigh", "max"], allowOff: true });
  });

  it("offers no PRO option, and a legacy pro flag is ignored", () => {
    expect(document.querySelector("#reasoning-levels-pro")).toBeNull();
    writeReasoningLevels({ efforts: ["max"], pro: true } as Parameters<typeof writeReasoningLevels>[0]);
    expect(readReasoningLevels()).toEqual({ efforts: ["max"] });
  });

  it("round-trips a profile, and an undeclared profile goes back to automatic", () => {
    writeReasoningLevels({ efforts: ["low", "high"] });
    expect(auto().checked).toBe(false);
    expect(readReasoningLevels()).toEqual({ efforts: ["low", "high"] });
    writeReasoningLevels(undefined);
    expect(auto().checked).toBe(true);
    expect(box("low").checked).toBe(false);
    expect(readReasoningLevels()).toBeUndefined();
  });

  it("an on/off-only API is a declaration with no efforts", () => {
    writeReasoningLevels({ efforts: [], allowOff: true });
    expect(readReasoningLevels()).toEqual({ efforts: [], allowOff: true });
  });
});
