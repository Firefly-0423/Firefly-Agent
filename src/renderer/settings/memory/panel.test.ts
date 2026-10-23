// @vitest-environment jsdom
import fs from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryPanelState } from "../../../shared/memory-panel-contracts";

function installApi(api: Record<string, unknown>): void {
  Object.defineProperty(window, "memoryPanel", { configurable: true, value: api });
}
function memoryState(overrides: Partial<MemoryPanelState> = {}): MemoryPanelState {
  return {
    facts: [],
    candidates: [],
    backendStatus: { available: true },
    coverage: { status: "not-measured", reason: "MEMORY_HISTORY_COVERAGE_NOT_MEASURED", population: null, present: null, missing: null, unknownDenied: null, exactRatio: null, lowerRatio: null, upperRatio: null, reasons: {}, evidence: { status: "not-evaluated", eligible: null, ineligible: null, unknown: null, ratio: null } },
    ...overrides,
  };
}
const fact = { factId: "fact-1", revision: 1, subjectKey: "preference", assertion: "我喜欢茶", assertionKind: "user-statement", time: { validFrom: null, validTo: null, referenceTime: null },
  sourceRef: { sourceId: "source-1", revision: 1 }, recordedAt: 2000, acceptedAt: 2500, supersededAt: null, activationReason: "policyAccepted", policyVersion: "test",
  provenance: { candidateId: null, evidenceId: null, activationSourceRef: { sourceId: "source-1", revision: 1 } } };
const text = (id: string) => document.getElementById(id)?.textContent ?? "";

async function mountPage(): Promise<() => Promise<void>> {
  vi.resetModules();
  document.body.innerHTML = fs.readFileSync("src/renderer/settings/index.html", "utf8");
  return (await import("./panel")).loadMemoryPanel;
}

beforeEach(() => { document.body.replaceChildren(); });

describe("memory settings page", () => {
  it("re-reads the shadow card when asked, without reloading the rest of the page", async () => {
    vi.resetModules();
    document.body.innerHTML = fs.readFileSync("src/renderer/settings/index.html", "utf8");
    const panel = await import("./panel");
    let used = 1;
    const shadowState = vi.fn(async () => ({ ok: true as const, state: { available: true, enabled: true, dailyCap: 50, revision: 1, day: "2026-10-15", used, stopped: null, records: 0, counters: {} } }));
    installApi({ getState: async () => memoryState(), getData: async () => ({ importedDocs: [] }), shadowState });
    await panel.refreshShadowPanel();
    expect(shadowState).not.toHaveBeenCalled();
    await panel.loadMemoryPanel();
    expect(text("memory-shadow-usage")).toBe("1 / 50 次");
    used = 7;
    await panel.refreshShadowPanel();
    expect(text("memory-shadow-usage")).toBe("7 / 50 次");
  });

  it("shows overview counts from the real state and hides source coverage unless the backend measured it", async () => {
    const load = await mountPage();
    installApi({
      getState: async () => memoryState({ facts: [fact], candidates: [{ candidateId: "c-1", revision: 1, attribute: "a", value: null, assertion: "候选", reason: "needs-review", sourceRef: { sourceId: "s", revision: 1 } }] }),
      getData: async () => ({ importedDocs: [] }),
    });
    await load();
    expect(text("memory-overview-service")).toBe("正常");
    expect(text("memory-overview-count")).toBe("1");
    expect(text("memory-overview-pending")).toBe("1");
    expect(text("memory-overview-updated")).not.toBe("暂无");
    expect(document.getElementById("memory-overview-coverage-row")?.classList.contains("is-hidden")).toBe(true);
  });
  it("shows measured coverage numbers when the backend actually measured them", async () => {
    const load = await mountPage();
    installApi({
      getState: async () => memoryState({ coverage: { ...memoryState().coverage, status: "measured", reason: undefined, population: 3, present: 2, missing: 1, unknownDenied: 0 } }),
      getData: async () => ({ importedDocs: [] }),
    });
    await load();
    expect(document.getElementById("memory-overview-coverage-row")?.classList.contains("is-hidden")).toBe(false);
    expect(text("memory-overview-coverage")).toContain("存在 2 / 3");
  });
  it("shows a read failure in the overview without exception details", async () => {
    const load = await mountPage();
    installApi({
      getState: async () => { throw new Error("/private/account secret"); },
      getData: async () => ({ importedDocs: [] }),
    });
    await load();
    expect(text("memory-overview-service")).toContain("读取失败");
    expect(text("memory-overview-service")).not.toMatch(/private|secret/);
    expect(text("memory-entries-body")).toContain("记忆读取失败");
  });
  it("renders imported documents as text and keeps a per-document delete control", async () => {
    const load = await mountPage();
    installApi({
      getState: async () => memoryState(),
      getData: async () => ({ importedDocs: [{ importId: "doc-1", fileName: "<img src=x>.txt", chunkCount: 2, lastImportedAt: 1000 }] }),
    });
    await load();
    const docs = document.getElementById("memory-imported-list")!;
    expect(docs.textContent).toContain("<img src=x>.txt");
    expect(docs.querySelector("img")).toBeNull();
    expect(docs.querySelector("[data-import-id=doc-1]")).not.toBeNull();
  });
  it("keeps imported documents usable when the memory state fails", async () => {
    const load = await mountPage();
    const calls: string[] = [];
    installApi({
      getState: async () => { calls.push("state"); throw new Error("private-token"); },
      getData: async () => { calls.push("documents"); return { importedDocs: [{ importId: "doc-1", fileName: "a.txt", chunkCount: 1, lastImportedAt: 1000 }] }; },
    });
    await load();
    expect(calls.sort()).toEqual(["documents", "state"]);
    expect(document.getElementById("memory-imported-list")?.querySelector("[data-import-id=doc-1]")).not.toBeNull();
  });
});
