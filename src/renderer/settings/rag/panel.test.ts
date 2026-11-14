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

test("clicking a reranker card sends that mode to the settings bridge and keeps the card selected", async () => {
  vi.resetModules();
  localStorage.clear();
  document.body.innerHTML = '<button class="rag-model-card" data-reranker data-value="standard"></button><button class="rag-model-card" data-reranker data-value="light"></button>';
  const setMode = vi.fn().mockResolvedValue(true);
  Object.assign(window, { settings: { rerankerSetMode: setMode, getRerankerStatus: vi.fn().mockResolvedValue({ light: true, standard: true }) } });
  await import("./panel");
  const cards = [...document.querySelectorAll<HTMLButtonElement>(".rag-model-card")];
  cards[1].click();
  await vi.waitFor(() => expect(setMode).toHaveBeenCalledTimes(1));
  expect(setMode).toHaveBeenCalledWith("light");
  expect(cards.map(card => card.classList.contains("is-active"))).toEqual([false, true]);
  expect(localStorage.getItem("firefly.reranker.mode")).toBe("light");
});

test("a rejected reranker mode change restores the previous card and stored mode", async () => {
  vi.resetModules();
  localStorage.clear();
  document.body.innerHTML = '<button class="rag-model-card" data-reranker data-value="standard"></button><button class="rag-model-card" data-reranker data-value="light"></button>';
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const setMode = vi.fn().mockRejectedValue(new Error("ipc down"));
  Object.assign(window, { settings: { rerankerSetMode: setMode, getRerankerStatus: vi.fn().mockResolvedValue({ light: false, standard: false }) } });
  await import("./panel");
  const cards = [...document.querySelectorAll<HTMLButtonElement>(".rag-model-card")];
  cards[0].classList.add("is-active");
  cards[1].click();
  await vi.waitFor(() => expect(warn).toHaveBeenCalledWith("[Reranker] set mode failed:", expect.any(Error)));
  expect(setMode).toHaveBeenCalledWith("light");
  expect(cards.map(card => card.classList.contains("is-active"))).toEqual([true, false]);
  expect(localStorage.getItem("firefly.reranker.mode")).toBe("standard");
});

test.each([
  { name: "standard reranker installed", status: { light: false, standard: true } as { light: boolean; standard: boolean } | undefined, label: "已下载 · 约 279MB" },
  { name: "standard reranker missing", status: { light: true, standard: false }, label: "未下载 · 可选" },
  { name: "status call rejects", status: undefined, label: "状态未知" },
])("reranker status label shows the right text when $name", async ({ status, label }) => {
  vi.resetModules();
  document.body.innerHTML = '<span id="reranker-standard-status">加载中</span>';
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const getStatus = status ? vi.fn().mockResolvedValue(status) : vi.fn().mockRejectedValue(new Error("ipc down"));
  Object.assign(window, { settings: { getRerankerStatus: getStatus } });
  await import("./panel");
  await vi.waitFor(() => expect(document.getElementById("reranker-standard-status")?.textContent).toBe(label));
  expect(getStatus).toHaveBeenCalledTimes(1);
});
