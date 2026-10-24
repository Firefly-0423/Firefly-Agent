// @vitest-environment jsdom
import { expect, it } from "vitest";
import { trackRangeFills } from "./range-fill";

it("marks how far each slider has travelled, for drags and for values set from code", async () => {
  document.body.innerHTML = '<input type="range" min="0" max="2" step="0.1" value="0.5">';
  trackRangeFills(document.body);
  const input = document.querySelector<HTMLInputElement>("input")!;
  expect(input.style.getPropertyValue("--ff-range-fill")).toBe("25%");
  input.value = "2";
  expect(input.style.getPropertyValue("--ff-range-fill")).toBe("100%");
  const late = Object.assign(document.createElement("input"), { type: "range" });
  late.value = "40";
  document.body.append(late);
  await Promise.resolve();
  expect(late.style.getPropertyValue("--ff-range-fill")).toBe("40%");
});
