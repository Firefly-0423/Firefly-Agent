// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { releaseFocusedDescendant } from "./focus-handoff";

afterEach(() => document.body.replaceChildren());

test.each([true, false])("releases focus only when containment is %s", (inside) => {
  const panel = document.createElement("section");
  const control = document.createElement("input");
  document.body.append(panel);
  (inside ? panel : document.body).append(control);
  control.focus();
  expect(document.activeElement).toBe(control);
  const released = releaseFocusedDescendant(panel);
  expect(released).toBe(inside);
  expect(document.activeElement).toBe(inside ? document.body : control);
});

test("accepts a missing container without moving focus", () => {
  const control = document.createElement("textarea");
  document.body.append(control);
  control.focus();
  expect(releaseFocusedDescendant(null)).toBe(false);
  expect(document.activeElement).toBe(control);
});
