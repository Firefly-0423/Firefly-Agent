import type { MemoryAutomationPanelApi, MemoryAutomationState } from "../../../shared/memory-automation-contracts";
import { t } from "../i18n";

/** Consent changes only through the settings bridge; a failed read never implies opt-in. */
export function createMemoryAutomationPanel(root: HTMLElement, api?: MemoryAutomationPanelApi) {
  const doc = root.ownerDocument;
  const text = (name: string, values?: Record<string, string | number>) => t(`settings.panel.memory.automation.${name}`, values);
  function element<K extends keyof HTMLElementTagNameMap>(tag: K, key?: string) {
    const node = doc.createElement(tag);
    if (key) { node.dataset.i18n = `settings.panel.memory.automation.${key}`; node.textContent = text(key); }
    return node;
  }
  const header = element("header"); header.className = "memory-section__head";
  const title = element("h2", "title"); title.id = "memory-automation-title";
  header.append(title, element("p", "desc"));
  const controls = new Map<"language" | "responseStyle", HTMLInputElement>();
  root.replaceChildren(header);
  for (const key of ["language", "responseStyle"] as const) {
    const row = element("div"), label = element("div"), strong = element("strong"); row.className = "setting-row";
    const input = element("input"); input.type = "checkbox"; input.dataset.memoryAutomation = key; input.disabled = true;
    input.id = `memory-automation-${key}`;
    const caption = element("label", key); caption.htmlFor = input.id; strong.append(caption); label.append(strong);
    const toggle = element("span"), track = element("span"), thumb = element("span"); toggle.className = "switch"; track.className = "switch__track"; thumb.className = "switch__thumb";
    track.append(thumb); toggle.append(input, track); row.append(label, toggle); root.append(row); controls.set(key, input);
    input.addEventListener("change", () => { void save(); });
  }
  const budget = element("p"), message = element("p"); budget.className = message.className = "memory-section__hint"; message.setAttribute("role", "status"); root.append(budget, message);
  let current: MemoryAutomationState | null = null, busy = false, generation = 0;
  function render() {
    for (const [key, input] of controls) { input.checked = current?.available === true && current.config[key]; input.disabled = busy || !current?.available; }
    budget.textContent = current?.available ? text("budget", { used: current.budget.requests }) + (current.counts["result-unknown"] ? ` ${text("unknown")}` : "") : "";
  }
  async function read(epoch: number): Promise<boolean> {
    try {
      const next = await api?.state(); if (generation !== epoch) return false;
      current = next?.available ? next : null; render();
      if (!current) message.textContent = text("unavailable");
      return !!current;
    } catch { if (generation === epoch) { current = null; render(); message.textContent = text("unavailable"); } return false; }
  }
  async function load(): Promise<void> {
    if (busy) return;
    message.textContent = ""; await read(++generation);
  }
  async function save(): Promise<void> {
    if (busy || !current?.available || !api) { render(); return; }
    const input = { expectedRevision: current.config.revision, language: controls.get("language")!.checked, responseStyle: controls.get("responseStyle")!.checked };
    const epoch = ++generation; busy = true; render(); message.textContent = text("saving");
    try {
      const result = await api.configure(input); if (epoch !== generation) return;
      if (result.status === "updated" && result.state.available) { current = result.state; message.textContent = text("saved"); }
      else if (await read(epoch)) message.textContent = text(result.status === "rejected" && result.reason === "MEMORY_REVISION_CONFLICT" ? "stale" : "failed");
    } catch { if (await read(epoch)) message.textContent = text("failed"); }
    finally { if (epoch === generation) { busy = false; render(); } }
  }
  return { load };
}
