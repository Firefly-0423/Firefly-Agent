// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupSettingsPage, flushMicrotasks, mountSettingsPage } from "./settings-harness.test-support";

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

function assertHidden(selector: string, expectedHidden: boolean): void {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
  expect(nodes.length).toBeGreaterThan(0);
  for (const node of nodes) {
    expect(node.classList.contains("is-hidden")).toBe(expectedHidden);
  }
}

describe("settings legacy glue: memory imported doc delete & scheduler wiring (T7)", () => {
  afterEach(() => {
    cleanupSettingsPage();
  });

  it("prompts before deleting an imported memory document, aborts cleanly on cancel or non-delete click, and deletes with docId & refreshes on confirm", async () => {
    const initialDocs = [
      { importId: "doc-1", fileName: "manual.txt", chunkCount: 3, lastImportedAt: 1000 },
      { importId: "doc-2", fileName: "notes.md", chunkCount: 1, lastImportedAt: 2000 },
    ];
    const remainingDocs = [initialDocs[1]];
    const getData = vi.fn()
      .mockResolvedValueOnce({ importedDocs: initialDocs })
      .mockResolvedValueOnce({ importedDocs: remainingDocs });
    const deleteImportedDoc = vi.fn(async () => ({ ok: true, deleted: 1 }));

    await mountSettingsPage({
      hash: "#memory",
      memoryPanel: { getData, deleteImportedDoc },
    });

    const list = byId("memory-imported-list");
    expect(getData).toHaveBeenCalledTimes(1);
    expect(list.querySelector('[data-import-id="doc-1"]')).not.toBeNull();
    expect(list.querySelector('[data-import-id="doc-2"]')).not.toBeNull();

    // Clicking outside .memory-record__delete does not open confirmation modal or delete
    list.querySelector<HTMLElement>(".memory-record__title")!.click();
    expect(document.querySelector(".ff-modal-overlay:not(.is-hidden)")).toBeNull();
    expect(deleteImportedDoc).toHaveBeenCalledTimes(0);

    // Clicking an inner SVG child delegates up to .memory-record__delete
    const doc1Btn = list.querySelector<HTMLButtonElement>('[data-import-id="doc-1"]')!;
    const innerSvg = doc1Btn.querySelector("svg")!;
    innerSvg.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const overlay = byId("ff-modal-overlay");
    expect(overlay.classList.contains("is-hidden")).toBe(false);
    expect(overlay.querySelector(".ff-modal")?.classList.contains("ff-modal--danger")).toBe(true);
    expect(byId("ff-modal-title").textContent).toBe("删除导入知识");
    expect(byId("ff-modal-message").textContent).toBe(
      "确定删除导入知识？\n\n文件：\n《manual.txt》\n\n删除后不可恢复，如需使用请重新导入。",
    );
    expect(byId("ff-modal-confirm").textContent).toBe("删除");
    expect(byId("ff-modal-cancel").textContent).toBe("取消");

    // Canceling modal does NOT call deleteImportedDoc and does NOT refresh list
    byId<HTMLButtonElement>("ff-modal-cancel").click();
    await flushMicrotasks();

    expect(overlay.classList.contains("is-hidden")).toBe(true);
    expect(deleteImportedDoc).toHaveBeenCalledTimes(0);
    expect(getData).toHaveBeenCalledTimes(1);
    expect(list.querySelector('[data-import-id="doc-1"]')).not.toBeNull();

    // Confirming modal calls deleteImportedDoc once with exact (importId, fileName) and refreshes
    doc1Btn.click();
    expect(overlay.classList.contains("is-hidden")).toBe(false);
    byId<HTMLButtonElement>("ff-modal-confirm").click();
    await flushMicrotasks();

    expect(deleteImportedDoc).toHaveBeenCalledTimes(1);
    expect(deleteImportedDoc).toHaveBeenCalledWith("doc-1", "manual.txt");
    expect(getData).toHaveBeenCalledTimes(2);
    expect(list.querySelector('[data-import-id="doc-1"]')).toBeNull();
    expect(list.querySelector('[data-import-id="doc-2"]')).not.toBeNull();
  });

  it("skips memory list reload when deleteImportedDoc fails or rejects, uses unnamed fallback, and resets to empty state after deleting last doc", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const getData = vi.fn()
        .mockResolvedValueOnce({
          importedDocs: [{ importId: "doc-x", fileName: "", chunkCount: 1, lastImportedAt: 1000 }],
        })
        .mockResolvedValueOnce({ importedDocs: [] });
      const deleteImportedDoc = vi.fn()
        .mockResolvedValueOnce({ ok: false, deleted: 0 })
        .mockRejectedValueOnce(new Error("disk busy"))
        .mockResolvedValueOnce({ ok: true, deleted: 1 });

      await mountSettingsPage({
        hash: "#memory",
        memoryPanel: { getData, deleteImportedDoc },
      });

      const list = byId("memory-imported-list");
      expect(getData).toHaveBeenCalledTimes(1);

      const trigger = () => list.querySelector<HTMLButtonElement>('[data-import-id="doc-x"]')!;

      // First delete attempt: bridge returns ok: false -> no list reload
      trigger().click();
      expect(byId("ff-modal-message").textContent).toContain("《未命名文档》");
      byId<HTMLButtonElement>("ff-modal-confirm").click();
      await flushMicrotasks();

      expect(deleteImportedDoc).toHaveBeenCalledTimes(1);
      expect(deleteImportedDoc).toHaveBeenLastCalledWith("doc-x", "未命名文档");
      expect(getData).toHaveBeenCalledTimes(1);
      expect(list.querySelector('[data-import-id="doc-x"]')).not.toBeNull();

      // Second delete attempt: bridge rejects -> caught without reloading list
      trigger().click();
      byId<HTMLButtonElement>("ff-modal-confirm").click();
      await flushMicrotasks();

      expect(deleteImportedDoc).toHaveBeenCalledTimes(2);
      expect(getData).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalled();

      // Third delete attempt: bridge resolves ok: true -> reloads list and displays empty message
      trigger().click();
      byId<HTMLButtonElement>("ff-modal-confirm").click();
      await flushMicrotasks();

      expect(deleteImportedDoc).toHaveBeenCalledTimes(3);
      expect(getData).toHaveBeenCalledTimes(2);
      expect(list.querySelector('[data-import-id="doc-x"]')).toBeNull();
      expect(list.textContent).toBe("暂无导入文档");
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("runs initial scheduler field sync on mount and wires kind & tool-limit change events through settings.ts", async () => {
    await mountSettingsPage({
      hash: "#tasks",
      scheduler: {
        list: vi.fn(async () => ({ ok: true, value: [] })),
        getTools: vi.fn(async () => ({
          ok: true,
          value: [{ id: "web_search", name: "Web Search", risk: "low", enabled: true }],
        })),
      },
    });

    const kindSelect = byId<HTMLSelectElement>("scheduler-kind");
    const toolLimit = byId<HTMLInputElement>("scheduler-tool-limit");
    const toolPicker = byId("scheduler-tool-picker");
    const toolEmptyHint = byId("scheduler-tool-empty-hint");

    // Startup updateSchedulerConditionalFields() synced initial #scheduler-kind ("once")
    expect(kindSelect.value).toBe("once");
    assertHidden(".scheduler-once-field", false);
    assertHidden(".scheduler-time-field", true);
    assertHidden(".scheduler-weekly-field", true);
    assertHidden(".scheduler-interval-field", true);
    expect(toolPicker.classList.contains("is-hidden")).toBe(true);
    expect(toolEmptyHint.classList.contains("is-hidden")).toBe(true);

    // Clicking #scheduler-new-btn opens editor and resets kind to "daily"
    byId<HTMLButtonElement>("scheduler-new-btn").click();
    await flushMicrotasks();
    expect(byId("scheduler-editor").classList.contains("is-hidden")).toBe(false);
    expect(kindSelect.value).toBe("daily");

    const scheduleMatrix = [
      { kind: "once", onceHidden: false, timeHidden: true, weeklyHidden: true, intervalHidden: true },
      { kind: "weekly", onceHidden: true, timeHidden: false, weeklyHidden: false, intervalHidden: true },
      { kind: "interval", onceHidden: true, timeHidden: true, weeklyHidden: true, intervalHidden: false },
      { kind: "daily", onceHidden: true, timeHidden: false, weeklyHidden: true, intervalHidden: true },
    ] as const;

    for (const row of scheduleMatrix) {
      kindSelect.value = row.kind;
      kindSelect.dispatchEvent(new Event("change", { bubbles: true }));
      assertHidden(".scheduler-once-field", row.onceHidden);
      assertHidden(".scheduler-time-field", row.timeHidden);
      assertHidden(".scheduler-weekly-field", row.weeklyHidden);
      assertHidden(".scheduler-interval-field", row.intervalHidden);
    }

    // Toggling schedulerToolLimitInput reveals tool picker & empty hint when no tools checked
    toolLimit.checked = true;
    toolLimit.dispatchEvent(new Event("change", { bubbles: true }));
    expect(toolPicker.classList.contains("is-hidden")).toBe(false);
    expect(toolEmptyHint.classList.contains("is-hidden")).toBe(false);

    // Checking a tool hides only the empty hint
    const toolCheckbox = toolPicker.querySelector<HTMLInputElement>('input[type="checkbox"][value="web_search"]')!;
    toolCheckbox.checked = true;
    toolCheckbox.dispatchEvent(new Event("change", { bubbles: true }));
    expect(toolPicker.classList.contains("is-hidden")).toBe(false);
    expect(toolEmptyHint.classList.contains("is-hidden")).toBe(true);

    // Turning tool limit off hides both picker and hint
    toolLimit.checked = false;
    toolLimit.dispatchEvent(new Event("change", { bubbles: true }));
    expect(toolPicker.classList.contains("is-hidden")).toBe(true);
    expect(toolEmptyHint.classList.contains("is-hidden")).toBe(true);
  });

  it("wires scheduler new, close, cancel, and save buttons from settings.ts", async () => {
    const list = vi.fn(async () => ({ ok: true, value: [] }));
    const add = vi.fn(async () => ({ ok: true }));
    await mountSettingsPage({
      hash: "#tasks",
      scheduler: {
        list,
        getTools: vi.fn(async () => ({
          ok: true,
          value: [{ id: "web_search", name: "Web Search", risk: "low", enabled: true }],
        })),
        add,
      },
    });

    const editor = byId("scheduler-editor");
    expect(list).toHaveBeenCalledTimes(1);
    expect(editor.classList.contains("is-hidden")).toBe(true);

    byId<HTMLButtonElement>("scheduler-new-btn").click();
    await flushMicrotasks();
    expect(editor.classList.contains("is-hidden")).toBe(false);

    byId<HTMLButtonElement>("scheduler-cancel-btn").click();
    expect(editor.classList.contains("is-hidden")).toBe(true);
    expect(add).toHaveBeenCalledTimes(0);

    byId<HTMLButtonElement>("scheduler-new-btn").click();
    await flushMicrotasks();
    expect(editor.classList.contains("is-hidden")).toBe(false);

    byId<HTMLButtonElement>("scheduler-editor-close").click();
    expect(editor.classList.contains("is-hidden")).toBe(true);
    expect(add).toHaveBeenCalledTimes(0);

    byId<HTMLButtonElement>("scheduler-new-btn").click();
    await flushMicrotasks();

    byId<HTMLInputElement>("scheduler-title").value = "晨间摘要";
    byId<HTMLTextAreaElement>("scheduler-prompt").value = "总结今日待办";
    byId<HTMLInputElement>("scheduler-time-of-day").value = "09:30";
    const toolLimit = byId<HTMLInputElement>("scheduler-tool-limit");
    toolLimit.checked = true;
    toolLimit.dispatchEvent(new Event("change", { bubbles: true }));
    byId("scheduler-tool-picker")
      .querySelector<HTMLInputElement>('input[type="checkbox"][value="web_search"]')!
      .checked = true;

    byId<HTMLButtonElement>("scheduler-save-btn").click();
    await flushMicrotasks();

    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith({
      title: "晨间摘要",
      prompt: "总结今日待办",
      enabled: true,
      schedule: { kind: "daily", timeOfDay: "09:30" },
      toolMode: "allow-list",
      allowedToolIds: ["web_search"],
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(editor.classList.contains("is-hidden")).toBe(true);
  });
});
