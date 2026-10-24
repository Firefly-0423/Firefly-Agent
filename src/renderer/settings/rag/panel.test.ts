// @vitest-environment jsdom
import { afterEach, test, expect, vi } from "vitest";

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

test("a rejected embedding model restores the selected card and explains the failure in shared feedback", async () => {
  vi.resetModules();
  localStorage.clear();
  document.body.innerHTML = '<button class="rag-model-card" data-value="bgem3"></button><button class="rag-model-card" data-value="text-embedding-3"></button>';
  const nativeAlert = vi.spyOn(window, "alert").mockImplementation(() => undefined);
  const setModel = vi.fn().mockResolvedValue({ ok: false, error: "维度不兼容" });
  Object.assign(window, { settings: { embeddingSetModel: setModel } });
  await import("./panel");
  const cards = [...document.querySelectorAll<HTMLButtonElement>(".rag-model-card")];
  cards[0].classList.add("is-active");
  cards[1].click();
  await vi.waitFor(() => {
    expect(document.querySelector("#ff-modal-overlay")?.textContent).toContain("维度不兼容");
  });
  expect(setModel).toHaveBeenCalledWith("text-embedding-3");
  expect(nativeAlert.mock.calls).toHaveLength(0);
  expect(cards.map(card => card.classList.contains("is-active"))).toEqual([true, false]);
  const feedback = document.querySelector("#ff-modal-overlay")!;
  expect(feedback).not.toBeNull();
  expect(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).toHaveLength(1);
  expect(feedback.textContent).toContain("模型切换失败");
  document.querySelector<HTMLButtonElement>("#ff-modal-confirm")?.click();
});
