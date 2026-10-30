// @vitest-environment jsdom
import { expect, it } from "vitest";
import { floatingArea } from "./FloatingComposer";

it("keeps the floating composer inside the dialog column, not over the overview cards beside it", () => {
  document.body.innerHTML = `<div class="ff-workspace"><div class="ff-workspace-body">
    <div class="ff-workspace-content"><div id="composer"></div></div>
    <aside class="ff-chat-cards"></aside></div></div>`;
  expect(floatingArea(document.getElementById("composer"))).toBe(document.querySelector(".ff-workspace-content"));
  expect(floatingArea(null)).toBeNull();
});
