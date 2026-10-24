// 记忆设置页编排：概览、我的记忆、导入知识三张卡片。
import type { MemoryPanelState } from "../../../shared/memory-panel-contracts";
import type { MemoryPanelApi, MemoryPanelPayload } from "../shared/types";
import { applyTranslations, t } from "../i18n";
import { formatDateTime } from "../shared/format";
import { createMemoryEntriesPanel } from "./entries-panel";
import { createShadowPanel } from "./shadow-panel";
import { createMemoryAutomationPanel } from "./automation-panel";
import type { MemoryAutomationPanelApi } from "../../../shared/memory-automation-contracts";

let entries: ReturnType<typeof createMemoryEntriesPanel> | null = null;
let entriesRoot: HTMLElement | null = null;
let translated = false;
let shadow: ReturnType<typeof createShadowPanel> | null = null;
let automation: ReturnType<typeof createMemoryAutomationPanel> | null = null;
let automationRoot: HTMLElement | null = null;
let importedDocs: MemoryPanelPayload["importedDocs"] = [];

function api(): MemoryPanelApi | undefined {
  return (window as Window & { memoryPanel?: MemoryPanelApi }).memoryPanel;
}
function setText(id: string, text: string): void {
  const node = document.getElementById(id);
  if (node) node.textContent = text;
}

/** 概览只展示真实读取到的数据；来源覆盖仅在后端真正统计时出现。 */
function renderOverview(state: MemoryPanelState | null): void {
  if (!state) {
    setText("memory-overview-service", t("settings.panel.memory.overview.serviceUnknown"));
    setText("memory-overview-count", "—");
    setText("memory-overview-pending", "—");
    setText("memory-overview-updated", "—");
    document.getElementById("memory-overview-coverage-row")?.classList.add("is-hidden");
    return;
  }
  setText("memory-overview-service", state.backendStatus.available
    ? t("settings.panel.memory.overview.serviceOk")
    : t("settings.panel.memory.overview.serviceDown"));
  setText("memory-overview-count", String(state.facts.length));
  setText("memory-overview-pending", String(state.candidates.length));
  const latest = state.facts.reduce((max, item) => Math.max(max, item.acceptedAt || 0, item.recordedAt || 0), 0);
  setText("memory-overview-updated", latest ? formatDateTime(latest) : t("settings.panel.memory.overview.never"));
  const coverage = state.coverage;
  const measured = coverage.status === "measured";
  document.getElementById("memory-overview-coverage-row")?.classList.toggle("is-hidden", !measured);
  if (measured) {
    setText("memory-overview-coverage", t("settings.panel.memory.overview.coverageValue", {
      present: coverage.present ?? "—",
      population: coverage.population ?? "—",
      missing: coverage.missing ?? "—",
      unknownDenied: coverage.unknownDenied ?? "—",
    }));
  }
}

async function loadImportedDocs(): Promise<void> {
  try {
    const payload = await api()?.getData();
    if (!payload || !Array.isArray(payload.importedDocs)) { docsMessage(t("settings.panel.memory.imported.unavailable")); return; }
    importedDocs = payload.importedDocs;
    renderImportedDocs();
  } catch { docsMessage(t("settings.panel.memory.imported.loadFailed")); }
}

function docsMessage(message: string): void {
  const list = document.getElementById("memory-imported-list");
  if (!list) return;
  const note = document.createElement("p");
  note.className = "memory-list__empty";
  note.textContent = message;
  list.replaceChildren(note);
}

function renderImportedDocs(): void {
  const list = document.getElementById("memory-imported-list");
  if (!list) return;
  if (!importedDocs.length) { docsMessage(t("settings.panel.memory.imported.empty")); return; }
  list.replaceChildren();
  for (const item of importedDocs) {
    const article = document.createElement("article"); article.className = "memory-record memory-record--doc";
    const main = document.createElement("div"); main.className = "memory-record__main";
    const title = document.createElement("h3"); title.className = "memory-record__title"; title.textContent = item.fileName;
    const body = document.createElement("p"); body.className = "memory-record__body";
    body.textContent = t("settings.panel.memory.imported.indexed", { n: item.chunkCount });
    const meta = document.createElement("p"); meta.className = "memory-record__meta";
    meta.textContent = t("settings.panel.memory.imported.importedAt", { time: formatDateTime(item.lastImportedAt) });
    main.append(title, body, meta);
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "memory-record__delete";
    remove.dataset.importId = item.importId || ""; remove.dataset.fileName = item.fileName;
    remove.title = t("settings.panel.memory.imported.deleteTitle");
    remove.setAttribute("aria-label", t("settings.panel.memory.imported.deleteAria", { name: item.fileName }));
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [name, value] of Object.entries({ width: "16", height: "16", viewBox: "0 0 48 48", fill: "none", "aria-hidden": "true" })) icon.setAttribute(name, value);
    for (const d of ["M8 15H40L37 44H11L8 15Z", "M20.002 25.0024V35.0026", "M28.0024 24.9995V34.9972", "M12 14.9999L28.3242 3L36 15"]) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      for (const [name, value] of Object.entries({ d, stroke: "currentColor", "stroke-width": "4", "stroke-linecap": "round", "stroke-linejoin": "round" })) path.setAttribute(name, value);
      icon.append(path);
    }
    remove.append(icon);
    article.append(main, remove); list.append(article);
  }
}

/** 切到记忆页时只重新读影子卡片的数字：窗口可能开了很久，期间已有抽取发生或已跨天。 */
export function refreshShadowPanel(): Promise<void> {
  return shadow?.load() ?? Promise.resolve();
}

export async function loadMemoryPanel(): Promise<void> {
  const root = document.getElementById("memory-entries-body");
  const page = document.getElementById("memory-panel");
  if (page && !translated) {
    // 静态文案跟随界面语言；订阅只需挂一次。
    translated = true;
    applyTranslations(page);
  }
  if (root && entriesRoot !== root) {
    entriesRoot = root;
    const bridge = api();
    entries = createMemoryEntriesPanel(root, typeof bridge?.getState === "function" ? bridge : undefined, renderOverview);
  }
  if (!shadow && document.getElementById("memory-shadow")) shadow = createShadowPanel(api);
  const consentRoot = document.getElementById("memory-automation");
  if (consentRoot && consentRoot !== automationRoot) {
    automationRoot = consentRoot;
    automation = createMemoryAutomationPanel(consentRoot, (window as Window & { memoryAutomation?: MemoryAutomationPanelApi }).memoryAutomation);
  }
  await Promise.all([entries?.load(), loadImportedDocs(), shadow?.load(), automation?.load()]);
}
