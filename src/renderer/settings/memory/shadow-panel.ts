// 记忆设置页：影子抽取（实验）卡片。开关默认关闭；开启前必须在页面上确认一次；清空也需要二次确认。
// 只显示开关、次数和计数，不显示任何消息内容；导出由主进程弹出保存对话框完成。
import type { ShadowPanelApi, ShadowPanelError, ShadowPanelState } from "../../../shared/memory-panel-contracts";
import { t } from "../i18n";

const MIN_CAP = 1;
const MAX_CAP = 1000;

function sum(counters: Record<string, number>, prefix: string): number {
  return Object.entries(counters).reduce((total, [key, value]) => total + (key.startsWith(prefix) ? value : 0), 0);
}

/** 状态文案：关闭优先，其次当天停止的原因，再是已达上限。 */
export function shadowStatusText(state: ShadowPanelState): string {
  if (!state.enabled) return t("settings.panel.memory.shadow.statusOff");
  if (state.stopped === "quota") return t("settings.panel.memory.shadow.statusQuota");
  if (state.stopped === "rate-limit") return t("settings.panel.memory.shadow.statusRate");
  if (state.used >= state.dailyCap) return t("settings.panel.memory.shadow.statusCap");
  return t("settings.panel.memory.shadow.statusOn");
}

type ShadowBridge = Partial<ShadowPanelApi> | undefined;
/** Pass the bridge itself, or a getter when it may not exist yet when the page first loads. */
export function createShadowPanel(source: ShadowBridge | (() => ShadowBridge)) {
  const bridge = (): ShadowBridge => (typeof source === "function" ? source() : source);
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;
  const el = {
    body: byId("memory-shadow-body"), note: byId("memory-shadow-note"), message: byId("memory-shadow-message"),
    enabled: byId<HTMLInputElement>("memory-shadow-enabled"), consent: byId("memory-shadow-consent"),
    consentOk: byId<HTMLButtonElement>("memory-shadow-consent-ok"), consentCancel: byId<HTMLButtonElement>("memory-shadow-consent-cancel"),
    cap: byId<HTMLInputElement>("memory-shadow-cap"), capSave: byId<HTMLButtonElement>("memory-shadow-cap-save"),
    status: byId("memory-shadow-status"), usage: byId("memory-shadow-usage"), records: byId("memory-shadow-records"), detail: byId("memory-shadow-detail"),
    exportButton: byId<HTMLButtonElement>("memory-shadow-export"), clear: byId<HTMLButtonElement>("memory-shadow-clear"),
    clearConfirm: byId("memory-shadow-clear-confirm"), clearOk: byId<HTMLButtonElement>("memory-shadow-clear-ok"), clearCancel: byId<HTMLButtonElement>("memory-shadow-clear-cancel"),
  };
  let state: ShadowPanelState | null = null;
  let busy = false;

  const say = (text: string) => { if (el.message) el.message.textContent = text; };
  const errorText = (error: ShadowPanelError) => t(`settings.panel.memory.shadow.error.${error}`);
  function showNote(text: string | null) {
    // The hidden attribute, not a class: some list styles set display and would keep an empty note visible.
    if (el.note) { el.note.hidden = text === null; el.note.textContent = text ?? ""; }
    if (el.body) el.body.hidden = text !== null;
  }
  function setBusy(value: boolean) {
    busy = value;
    for (const control of [el.enabled, el.consentOk, el.consentCancel, el.cap, el.capSave, el.exportButton, el.clear, el.clearOk, el.clearCancel]) if (control) control.disabled = value;
    if (!value) syncRecordButtons();
  }
  function syncRecordButtons() {
    const empty = !state || state.records === 0;
    if (el.exportButton) el.exportButton.disabled = busy || empty;
    if (el.clear) el.clear.disabled = busy || empty;
  }
  function hideConfirmations() {
    el.consent?.classList.add("is-hidden");
    el.clearConfirm?.classList.add("is-hidden");
  }
  function render(next: ShadowPanelState) {
    state = next;
    if (el.enabled) el.enabled.checked = next.enabled;
    if (el.cap && document.activeElement !== el.cap) el.cap.value = String(next.dailyCap);
    if (el.status) el.status.textContent = shadowStatusText(next);
    if (el.usage) el.usage.textContent = t("settings.panel.memory.shadow.usageValue", { used: next.used, cap: next.dailyCap });
    if (el.records) el.records.textContent = t("settings.panel.memory.shadow.recordsValue", { n: next.records });
    if (el.detail) el.detail.textContent = t("settings.panel.memory.shadow.detailValue", {
      skipped: sum(next.counters, "skip:") + sum(next.counters, "refuse:"), errors: sum(next.counters, "error:"), cancelled: sum(next.counters, "cancel:"), dropped: sum(next.counters, "drop:"),
    });
    syncRecordButtons();
  }

  async function load(): Promise<void> {
    const api = bridge();
    if (!api?.shadowState) { showNote(t("settings.panel.memory.shadow.unavailable")); return; }
    try {
      const result = await api.shadowState();
      if (!result.ok) { showNote(errorText(result.error)); return; }
      if (!result.state.available) { showNote(t("settings.panel.memory.shadow.unavailable")); return; }
      showNote(null); render(result.state);
    } catch { showNote(t("settings.panel.memory.shadow.loadFailed")); }
  }

  /** 统一处理需要状态返回值的操作：成功则刷新并提示；版本冲突则重新读取。 */
  async function run(action: () => Promise<{ ok: true; state: ShadowPanelState } | { ok: false; error: ShadowPanelError }>, success: string) {
    if (busy) return;
    setBusy(true); say("");
    try {
      const result = await action();
      if (result.ok) { render(result.state); say(success); }
      else { say(errorText(result.error)); if (result.error === "SHADOW_REVISION_CONFLICT") { setBusy(false); await load(); return; } }
    } catch { say(t("settings.panel.memory.shadow.error.SHADOW_FAILED")); }
    finally { setBusy(false); }
    if (state && el.enabled) el.enabled.checked = state.enabled;
  }
  const currentCap = () => {
    const value = Number(el.cap?.value);
    return Number.isInteger(value) && value >= MIN_CAP && value <= MAX_CAP ? value : null;
  };

  el.enabled?.addEventListener("change", () => {
    const api = bridge();
    if (!state || !api?.shadowConfigure) return;
    hideConfirmations(); say("");
    if (el.enabled!.checked) {
      // 开启前先在页面上确认；确认之前开关保持关闭状态。
      el.enabled!.checked = false;
      el.consent?.classList.remove("is-hidden");
      el.consentOk?.focus();
      return;
    }
    const expectedRevision = state.revision, dailyCap = state.dailyCap;
    void run(() => api.shadowConfigure!({ enabled: false, dailyCap, expectedRevision }), t("settings.panel.memory.shadow.disabledDone"));
  });
  el.consentCancel?.addEventListener("click", () => { el.consent?.classList.add("is-hidden"); el.enabled?.focus(); });
  el.consentOk?.addEventListener("click", () => {
    const api = bridge();
    if (!state || !api?.shadowConfigure) return;
    const cap = currentCap() ?? state.dailyCap, expectedRevision = state.revision;
    el.consent?.classList.add("is-hidden");
    void run(() => api.shadowConfigure!({ enabled: true, dailyCap: cap, expectedRevision }), t("settings.panel.memory.shadow.enabledDone"));
  });
  el.capSave?.addEventListener("click", () => {
    const api = bridge();
    if (!state || !api?.shadowConfigure) return;
    const cap = currentCap();
    if (cap === null) { say(t("settings.panel.memory.shadow.capInvalid")); return; }
    const enabled = state.enabled, expectedRevision = state.revision;
    void run(() => api.shadowConfigure!({ enabled, dailyCap: cap, expectedRevision }), t("settings.panel.memory.shadow.saved"));
  });
  el.exportButton?.addEventListener("click", async () => {
    const api = bridge();
    if (busy || !api?.shadowExport) return;
    setBusy(true); say("");
    try {
      const result = await api.shadowExport();
      if (!result.ok) say(errorText(result.error));
      else say(result.canceled ? t("settings.panel.memory.shadow.exportCanceled") : t("settings.panel.memory.shadow.exportDone", { n: result.count }));
    } catch { say(t("settings.panel.memory.shadow.error.SHADOW_FAILED")); }
    finally { setBusy(false); }
  });
  el.clear?.addEventListener("click", () => { say(""); el.consent?.classList.add("is-hidden"); el.clearConfirm?.classList.remove("is-hidden"); el.clearCancel?.focus(); });
  el.clearCancel?.addEventListener("click", () => { el.clearConfirm?.classList.add("is-hidden"); el.clear?.focus(); });
  el.clearOk?.addEventListener("click", () => {
    const api = bridge();
    if (!api?.shadowClear) return;
    el.clearConfirm?.classList.add("is-hidden");
    void run(() => api.shadowClear!(), t("settings.panel.memory.shadow.clearDone"));
  });

  return { load };
}
