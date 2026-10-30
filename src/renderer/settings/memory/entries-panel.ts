// “我的记忆”卡片：列出已记住的内容与待确认的候选，支持搜索、类型筛选、编辑（纠正）、遗忘、确认、拒绝与来源查看。
import type { FactView } from "../../../shared/memory-contracts";
import type { MemoryPanelAction, MemoryPanelCandidate, MemoryPanelState, MemoryPolicyPanelApi } from "../../../shared/memory-panel-contracts";
import { t } from "../i18n";
import { formatDateTime } from "../shared/format";
import { buildMemoryGraph, type MemoryGraphNode } from "./graph-model";
import { createMemoryGraph } from "./graph-panel";

type Filter = "all" | "facts" | "candidates";
type View = "list" | "graph";

/** 记忆内容全部按文本渲染；渲染层不构造任何身份或来源凭证。 */
export function createMemoryEntriesPanel(
  root: HTMLElement,
  api: MemoryPolicyPanelApi | undefined,
  onState?: (state: MemoryPanelState | null) => void,
) {
  const doc = root.ownerDocument;
  let busy = false;
  let readGeneration = 0;
  let state: MemoryPanelState | null = null;
  let loadError: string | null = null;
  let filter: Filter = "all";
  let query = "";
  let view: View = "list";
  /** Graph view: the node picked last; the list under the graph shows only what belongs to it. */
  let focus: MemoryGraphNode | null = null;
  let graph: ReturnType<typeof createMemoryGraph> | undefined;

  function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function time(value: number | null | undefined): string {
    return formatDateTime(value ?? 0);
  }
  /** " · 所有会话" / " · 仅限项目「name」"; empty when the policy did not report a scope. */
  function scopeText(item: { scope?: "global" | "project"; projectName?: string }): string {
    if (!item.scope) return "";
    if (item.scope === "global") return ` · ${t("settings.panel.memory.entries.scopeGlobal")}`;
    return ` · ${item.projectName ? t("settings.panel.memory.entries.scopeProjectNamed", { name: item.projectName }) : t("settings.panel.memory.entries.scopeProject")}`;
  }
  function setDisabled() {
    root.querySelectorAll<HTMLButtonElement>("[data-memory-action]").forEach((node) => {
      node.disabled = busy || !state?.backendStatus.available;
    });
  }
  function button(parent: HTMLElement, label: string, action: string, handler: () => void): HTMLButtonElement {
    const node = element("button", "save-btn save-btn--ghost", label);
    node.type = "button";
    node.dataset.memoryAction = action;
    node.addEventListener("click", () => { if (!busy && state?.backendStatus.available) handler(); });
    parent.append(node);
    return node;
  }

  // 搜索与类型筛选只在本地过滤已读取的数据，不改变后端状态。
  const toolbar = element("div", "memory-toolbar");
  const search = element("input", "memory-search-input") as HTMLInputElement;
  search.type = "search";
  search.placeholder = t("settings.panel.memory.entries.searchPlaceholder");
  search.setAttribute("aria-label", t("settings.panel.memory.entries.searchLabel"));
  search.addEventListener("input", () => { query = search.value.trim().toLowerCase(); renderList(); });
  const filterGroup = element("div", "option-blocks");
  filterGroup.setAttribute("role", "group");
  filterGroup.setAttribute("aria-label", t("settings.panel.memory.entries.filterLabel"));
  const filterButtons = ([
    ["all", t("settings.panel.memory.entries.filterAll")],
    ["facts", t("settings.panel.memory.entries.filterFacts")],
    ["candidates", t("settings.panel.memory.entries.filterPending")],
  ] as const).map(([value, label]) => {
    const node = element("button", "option-block", label);
    node.type = "button";
    node.dataset.memoryFilter = value;
    node.addEventListener("click", () => {
      filter = value;
      for (const item of filterButtons) {
        const active = item.dataset.memoryFilter === value;
        item.classList.toggle("is-active", active);
        item.setAttribute("aria-pressed", String(active));
      }
      renderList();
    });
    filterGroup.append(node);
    return node;
  });
  filterButtons[0].classList.add("is-active");
  filterButtons[0].setAttribute("aria-pressed", "true");
  filterButtons.slice(1).forEach((node) => node.setAttribute("aria-pressed", "false"));
  // 列表 / 关系图：关系图里点节点，下面的列表只显示与它相关的卡片，操作与列表完全相同。
  const viewGroup = element("div", "option-blocks");
  viewGroup.setAttribute("role", "group");
  viewGroup.setAttribute("aria-label", t("settings.panel.memory.entries.viewLabel"));
  const viewButtons = ([["list", t("settings.panel.memory.entries.viewList")], ["graph", t("settings.panel.memory.entries.viewGraph")]] as const).map(([value, label]) => {
    const node = element("button", "option-block", label);
    node.type = "button";
    node.dataset.memoryView = value;
    node.setAttribute("aria-pressed", String(value === view));
    node.classList.toggle("is-active", value === view);
    node.addEventListener("click", () => {
      if (view === value) return;
      view = value; focus = null;
      for (const item of viewButtons) {
        const active = item.dataset.memoryView === value;
        item.classList.toggle("is-active", active); item.setAttribute("aria-pressed", String(active));
      }
      search.hidden = filterGroup.hidden = value === "graph";
      renderGraph(); renderList();
    });
    viewGroup.append(node);
    return node;
  });
  toolbar.append(search, filterGroup, viewGroup);
  const graphRoot = element("div", "memory-graph-wrap");
  graphRoot.hidden = true;

  const list = element("div", "memory-list");
  const feedback = element("p", "memory-record__body");
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  root.replaceChildren(toolbar, graphRoot, list, feedback);

  function empty(message: string) {
    list.replaceChildren(element("p", "memory-list__empty", message));
  }
  function row(title: string, meta: string) {
    const article = element("article", "memory-record");
    const main = element("div", "memory-record__main");
    const actions = element("div", "memory-record__actions");
    main.append(element("h3", "memory-record__title", title), element("p", "memory-record__meta", meta), actions);
    article.append(main);
    return { article, main, actions };
  }
  function reasonText(reason: string | undefined, action: MemoryPanelAction["kind"]): string {
    switch (reason) {
      case "MEMORY_CONFIRMATION_STALE":
      case "MEMORY_REVISION_CONFLICT": return t("settings.panel.memory.entries.reason.revision");
      case "MEMORY_CANDIDATE_NOT_FOUND":
      case "MEMORY_FACT_NOT_FOUND": return t("settings.panel.memory.entries.reason.notFound");
      case "MEMORY_POLICY_SECRET": return t("settings.panel.memory.entries.reason.secret");
      case "MEMORY_POLICY_UNRESOLVED": return t(action === "confirm" ? "settings.panel.memory.entries.referenceNeedsRestatement" : "settings.panel.memory.entries.reason.unresolved");
      case "MEMORY_BACKEND_UNAVAILABLE": return t("settings.panel.memory.entries.reason.backend");
      default: return t("settings.panel.memory.entries.reason.failed");
    }
  }

  async function submit(action: MemoryPanelAction) {
    if (busy || !api || !state?.backendStatus.available) return;
    busy = true; setDisabled(); feedback.textContent = t("settings.panel.memory.entries.busy");
    try {
      const result = await api.applyAction(action);
      const success = action.kind === "reject"
        ? result.status === "rejected" && result.candidateId === action.id
        : result.status === (action.kind === "forget" ? "forgotten" : "active");
      // 无论成功与否都重新读取：失败时目标可能已被别处修改，不能直接重提同一操作。
      await load();
      feedback.textContent = success
        ? t(`settings.panel.memory.entries.saved.${action.kind}`)
        : reasonText(result.reason, action.kind);
    } catch {
      feedback.textContent = t("settings.panel.memory.entries.reason.failed");
    } finally { busy = false; setDisabled(); }
  }

  function renderFact(item: FactView) {
    const kind = item.assertionKind === "inference" ? t("settings.panel.memory.entries.kindInference") : t("settings.panel.memory.entries.kindUser");
    const activation = item.activationReason === "explicitUserConfirmed"
      ? t("settings.panel.memory.entries.activationConfirmed")
      : t("settings.panel.memory.entries.activationAuto");
    const effective = [
      item.time.validFrom != null ? t("settings.panel.memory.entries.effectiveFrom", { time: time(item.time.validFrom) }) : "",
      item.time.validTo != null ? t("settings.panel.memory.entries.effectiveUntil", { time: time(item.time.validTo) }) : "",
    ].filter(Boolean).map((part) => ` · ${part}`).join("");
    const entry = row(item.assertion, `${kind} · ${activation}${scopeText(item)} · ${t("settings.panel.memory.entries.recordedAt", { time: time(item.recordedAt) })}${effective}`);
    button(entry.actions, t("settings.panel.memory.entries.edit"), "correct", () => {
      if (entry.main.querySelector("textarea")) return;
      const editor = element("div", "memory-field memory-field--full");
      const label = element("label", "", t("settings.panel.memory.entries.editLabel"));
      const input = element("textarea", ""); input.value = item.assertion; input.rows = 3; input.maxLength = 65536;
      label.append(input); editor.append(label);
      button(editor, t("settings.panel.memory.entries.saveEdit"), "save-correction", () => {
        const text = input.value.trim();
        if (!text) { feedback.textContent = t("settings.panel.memory.entries.emptyCorrection"); input.focus(); return; }
        void submit({ kind: "correct", id: item.factId, expectedRevision: item.revision, text });
      });
      button(editor, t("settings.panel.memory.entries.cancel"), "cancel-correction", () => editor.remove());
      entry.main.append(editor); input.focus();
    });
    button(entry.actions, t("settings.panel.memory.entries.forget"), "forget", () => { void submit({ kind: "forget", id: item.factId, expectedRevision: item.revision }); });
    button(entry.actions, t("settings.panel.memory.entries.source"), "source", () => {
      if (!api) return;
      entry.main.querySelector("[data-memory-provenance]")?.remove();
      const details = element("div", "memory-record__body", t("settings.panel.memory.entries.source.loading"));
      details.dataset.memoryProvenance = "true";
      entry.main.append(details);
      void api.auditSource(item.factId).then((audit) => {
        const statusLabel = audit.status === "eligible"
          ? t("settings.panel.memory.entries.source.statusEligible")
          : audit.status === "forgotten"
            ? t("settings.panel.memory.entries.source.statusForgotten")
            : t("settings.panel.memory.entries.source.statusPendingReview");
        details.replaceChildren(element("p", "memory-record__meta", statusLabel));
        for (const source of audit.sources) {
          const kindLabel = source.kind === "explicitUserConfirmed"
            ? t("settings.panel.memory.entries.source.kindConfirmed")
            : source.kind === "review"
              ? t("settings.panel.memory.entries.source.kindReview")
              : t("settings.panel.memory.entries.source.kindAutomatic");
          const when = source.occurredAt == null ? t("settings.panel.memory.entries.source.unknownTime") : time(source.occurredAt);
          details.append(element("p", "memory-record__meta", `${kindLabel} · ${when}`));
        }
        if (!audit.sources.length) details.append(element("p", "memory-record__meta", t("settings.panel.memory.entries.source.none")));
      }).catch(() => { details.textContent = t("settings.panel.memory.entries.source.failed"); });
    });
    list.append(entry.article);
  }

  function renderCandidate(item: MemoryPanelCandidate) {
    const ready = item.reviewState === "ready" && !!item.assertion.trim();
    const effective = [item.time?.validFrom != null ? t("settings.panel.memory.entries.effectiveFrom", {time:time(item.time.validFrom)}) : "", item.time?.validTo != null ? t("settings.panel.memory.entries.effectiveUntil", {time:time(item.time.validTo)}) : ""].filter(Boolean).map(part=>` · ${part}`).join("");
    const entry = row(
      ready ? item.assertion : t("settings.panel.memory.entries.referenceTitle"),
      `${t(ready ? "settings.panel.memory.entries.pendingTag" : "settings.panel.memory.entries.referenceTag")} · ${t(ready ? "settings.panel.memory.entries.pendingNeedsConfirm" : "settings.panel.memory.entries.referenceNeedsRestatement")}${scopeText(item)} · ${time(item.occurredAt)}${effective}`,
    );
    if (ready && item.contentHash && /^[a-f0-9]{64}$/.test(item.contentHash)) {
      button(entry.actions, t("settings.panel.memory.entries.confirm"), "confirm", () => { void submit({ kind: "confirm", id: item.candidateId, expectedRevision: item.revision, contentHash: item.contentHash }); });
    }
    button(entry.actions, t("settings.panel.memory.entries.reject"), "reject", () => { void submit({ kind: "reject", id: item.candidateId, expectedRevision: item.revision }); });
    list.append(entry.article);
  }

  function graphLabel(key: string): string {
    return key === "self" || key === "untitled" ? t(`settings.panel.memory.graph.${key}`) : t(`settings.panel.memory.graph.category.${key}`);
  }
  function renderGraph(): void {
    graphRoot.hidden = view !== "graph" || !state?.backendStatus.available;
    if (graphRoot.hidden || !state) return;
    if (!state.facts.length && !state.candidates.length) {
      graph?.destroy(); graph = undefined;
      graphRoot.replaceChildren(element("p", "memory-list__empty", t("settings.panel.memory.graph.empty"))); return;
    }
    graph ??= createMemoryGraph(graphRoot, { label: t("settings.panel.memory.graph.label"), onSelect: (node) => { focus = node; renderList(); } });
    graph.update(buildMemoryGraph(state, graphLabel));
  }
  /** Whether a fact or candidate belongs to the node picked in the graph. */
  function focused(item: { sourceRef: { binding?: { sessionId: string } }; projectName?: string }, id: string): boolean {
    if (!focus) return false;
    if (focus.kind === "source") return `source:${item.sourceRef.binding?.sessionId}` === focus.id;
    if (focus.kind === "project") return `project:${item.projectName}` === focus.id;
    return focus.itemId === id;
  }

  function renderList(): void {
    list.replaceChildren();
    if (loadError) { empty(loadError); return; }
    if (!state) { empty(t("settings.panel.memory.loading")); return; }
    if (!state.backendStatus.available) { empty(t("settings.panel.memory.entries.backendDown")); return; }
    if (view === "graph") {
      const facts = state.facts.filter((item) => focused(item, item.factId)), candidates = state.candidates.filter((item) => focused(item, item.candidateId));
      facts.forEach(renderFact); candidates.forEach(renderCandidate);
      if (!facts.length && !candidates.length && (state.facts.length || state.candidates.length)) empty(t("settings.panel.memory.graph.hint"));
      return;
    }
    const matches = (text: string) => !query || text.toLowerCase().includes(query);
    const facts = filter === "candidates" ? [] : state.facts.filter((item) => matches(item.assertion));
    const candidates = filter === "facts" ? [] : state.candidates.filter((item) => matches(item.assertion));
    facts.forEach(renderFact);
    candidates.forEach(renderCandidate);
    if (!facts.length && !candidates.length) {
      empty(query
        ? t("settings.panel.memory.entries.emptySearch")
        : filter === "facts"
          ? t("settings.panel.memory.entries.emptyFacts")
          : filter === "candidates"
            ? t("settings.panel.memory.entries.emptyPending")
            : t("settings.panel.memory.entries.emptyAll"));
    }
  }

  function apply(value: MemoryPanelState | null, error: string | null) {
    state = value;
    loadError = error;
    onState?.(value);
    renderGraph();
    renderList();
    setDisabled();
  }

  async function load(): Promise<void> {
    const generation = ++readGeneration;
    if (!api) { apply(null, t("settings.panel.memory.entries.apiMissing")); return; }
    try {
      const value = await api.getState();
      if (generation === readGeneration) apply(value, null);
    } catch {
      if (generation === readGeneration) apply(null, t("settings.panel.memory.entries.loadFailed"));
    }
  }

  renderList();
  return { load };
}
