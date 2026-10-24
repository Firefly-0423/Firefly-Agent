import type {} from "../../global";
import type { SettingsApi } from "../shared/types";
import { showAlert, showConfirm, showInputModal, showNotice } from "../shared/modal";
import { parseCommandLine } from "../shared/parse";
import { subscribeLocaleChanged, t } from "../i18n";

type McpServer = Awaited<ReturnType<NonNullable<SettingsApi["listMcpServers"]>>>[number] & { enabled: boolean };
// Main only ever sends one of these fixed reasons; anything else is shown as an unknown failure.
const FAILURE_REASONS = new Set(["command-not-found", "permission-denied", "timeout", "exited", "unreachable", "failed"]);
const knownReason = (reason: unknown): string | undefined => typeof reason === "string" ? (FAILURE_REASONS.has(reason) ? reason : "failed") : undefined;
const label = (key: string, values?: Record<string, string | number>) => t(`settings.mcpUi.${key}`, values);

/** Keep presentation state local; Main remains the connection/configuration owner.
 * https://www.electronjs.org/docs/latest/tutorial/ipc#pattern-2-renderer-to-main-two-way
 */
export function mountMcpManagement(addButton: HTMLButtonElement | null): { add: () => Promise<void>; dispose: () => void } | undefined {
  // The MCP page owns its heading and Add button; this module fills in the list below them.
  const host = addButton?.closest("#mcp-panel")?.querySelector(".mcp-server-host");
  if (!addButton || !host) return;

  const section = document.createElement("section");
  section.id = "mcp-management";
  section.className = "mcp-management";
  section.setAttribute("aria-labelledby", "mcp-panel-title");
  // All interpolated content below uses textContent, never service-provided HTML.
  section.innerHTML = '<div class="mcp-management__toolbar"><button type="button" class="btn-secondary" id="mcp-refresh-btn"></button></div><p id="mcp-server-feedback" role="status" aria-live="polite"></p><div id="mcp-server-list" class="plugin-list"></div>';
  host.append(section);
  const refreshButton = section.querySelector<HTMLButtonElement>("#mcp-refresh-btn")!;
  const feedback = section.querySelector<HTMLElement>("#mcp-server-feedback")!;
  const list = section.querySelector<HTMLElement>("#mcp-server-list")!;
  let disposed = false;
  let pending = false;
  let loading = false;
  let loaded = false;
  let readError = false;
  let readVersion = 0;
  let servers: McpServer[] = [];
  const alive = () => !disposed && section.isConnected;

  function render(): void {
    if (!alive()) return;
    addButton!.textContent = label("add");
    addButton!.disabled = pending || !window.settings?.addMcpServer;
    refreshButton.textContent = label(loading ? "loading" : "refresh");
    refreshButton.disabled = pending || loading || !window.settings?.listMcpServers;
    section.setAttribute("aria-busy", String(pending || loading));
    feedback.textContent = readError ? label("readFailed") : "";
    feedback.setAttribute("role", readError ? "alert" : "status");
    list.replaceChildren();
    for (const server of servers) {
      const card = document.createElement("article");
      card.className = "plugin-card mcp-server-card";
      const body = document.createElement("div");
      body.className = "plugin-card__body";
      const name = document.createElement("h3");
      name.textContent = server.name;
      const status = document.createElement("p");
      const reason = knownReason(server.failure);
      status.textContent = !server.enabled ? label("disabled")
        : server.connected ? label("connected", { count: server.toolCount })
        : reason ? label("disconnectedReason", { reason: label(`failure.${reason}`) })
        : label("disconnected", { count: server.toolCount });
      status.className = "mcp-server-status";
      body.append(name, status);
      card.append(body);
      // This built-in is owned by syncPlaywrightMcp and its existing toggle.
      if (server.id === "playwright-mcp") {
        const note = document.createElement("p");
        note.className = "panel-hint";
        note.textContent = label("builtin");
        body.append(note);
        // The Playwright toggle lives on the Tools page, which is hidden while this page is open.
        const openTools = document.createElement("button");
        openTools.type = "button";
        openTools.className = "btn-secondary";
        openTools.textContent = label("openTools");
        openTools.addEventListener("click", () => { document.querySelector<HTMLButtonElement>('.nav-item[data-section="plugins"]')?.click(); });
        card.append(openTools);
      } else {
        const actions = document.createElement("div");
        actions.className = "mcp-server-actions";
        const control = (text: string, aria: string, run: () => void, key: string) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "btn-secondary";
          button.textContent = text;
          button.setAttribute("aria-label", aria);
          button.dataset.mcpAction = `${key}:${server.id}`;
          button.disabled = pending || !window.settings?.setMcpServerEnabled;
          button.addEventListener("click", run);
          return button;
        };
        if (!server.enabled) actions.append(control(label("enable"), label("enableNamed", { name: server.name }), () => { void setEnabled(server, true, "enabledNotice"); }, "enable"));
        else {
          if (!server.connected) actions.append(control(label("reconnect"), label("reconnectNamed", { name: server.name }), () => { void setEnabled(server, true, "reconnectedNotice"); }, "enable"));
          actions.append(control(label("disable"), label("disableNamed", { name: server.name }), () => { void setEnabled(server, false, "disabledNotice"); }, "disable"));
        }
        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.className = "btn-secondary btn-danger";
        removeButton.textContent = label("remove");
        removeButton.setAttribute("aria-label", label("removeNamed", { name: server.name }));
        removeButton.dataset.mcpRemove = server.id;
        removeButton.disabled = pending || !window.settings?.removeMcpServer;
        removeButton.addEventListener("click", () => { void remove(server); });
        actions.append(removeButton);
        card.append(actions);
      }
      list.append(card);
    }
    if (servers.length === 0 && loaded && !readError) {
      const empty = document.createElement("p");
      empty.className = "panel-hint";
      empty.textContent = label("empty");
      list.append(empty);
    }
  }

  async function refresh(): Promise<void> {
    if (!alive()) return;
    const version = ++readVersion;
    loading = true;
    render();
    try {
      if (!window.settings?.listMcpServers) throw new Error("MCP_LIST_UNAVAILABLE");
      const result = await window.settings.listMcpServers();
      if (!alive() || version !== readVersion) return;
      if (!Array.isArray(result)) throw new Error("MCP_LIST_INVALID");
      // Explicit projection: commands, env and arbitrary extra fields never enter UI state.
      servers = result.map(server => ({ id: server.id, name: server.name, connected: server.connected, toolCount: server.toolCount, toolIds: [],
        enabled: server.enabled !== false, ...(knownReason(server.failure) ? { failure: knownReason(server.failure) } : {}) }));
      loaded = true;
      readError = false;
    } catch {
      if (!alive() || version !== readVersion) return;
      readError = true;
    } finally {
      if (alive() && version === readVersion) { loading = false; render(); }
    }
  }

  function begin(): boolean {
    if (!alive() || pending) return false;
    pending = true;
    render();
    return true;
  }
  function invalidateRead(): void {
    // Confirmation is still read-only. Invalidate only when a mutation starts,
    // so canceling a dialog cannot discard the initial list permanently.
    readVersion++;
    loading = false;
    render();
  }
  function finish(): void {
    if (!alive()) return;
    pending = false;
    render();
  }
  async function failure(action: "add" | "remove" | "enable" | "disable", rawReason?: unknown): Promise<void> {
    if (!alive()) return;
    // MCP transport errors may echo process arguments, URLs or credentials.
    // Do not log or show arbitrary error objects in this renderer; only the fixed reason from Main is shown.
    const reason = knownReason(rawReason);
    const message = reason && action === "add" ? label("addFailedWhy", { reason: label(`failure.${reason}`) })
      : reason && action === "enable" ? label("enableFailedWhy", { reason: label(`failure.${reason}`) })
      : label(`${action}FailedMessage`);
    await showAlert({ tone: "error", title: label(`${action}Failed`), message });
  }

  async function add(): Promise<void> {
    if (!begin()) return;
    try {
      if (!window.settings?.addMcpServer) { await failure("add"); return; }
      const command = await showInputModal({ title: label("add"), message: label("commandPrompt"), placeholder: "node path/to/server.js --flag" });
      if (!alive() || !command?.trim()) return;
      const parsed = parseCommandLine(command.trim());
      if (!parsed.command) { showNotice({ tone: "warning", message: label("invalidCommand") }); return; }
      const nameInput = await showInputModal({ title: label("nameTitle"), message: label("namePrompt"), placeholder: label("namePlaceholder") });
      if (!alive() || nameInput === null) return;
      const name = nameInput.trim() || label("unnamed");
      const approved = await showConfirm({ tone: "warning", dangerous: true, title: label("runTitle"), message: label("runMessage", { command: command.trim() }), confirmText: label("run"), cancelText: label("cancel") });
      if (!alive() || !approved) return;
      invalidateRead();
      const result = await window.settings.addMcpServer({ id: `mcp-${crypto.randomUUID()}`, name, transport: "stdio", command: parsed.command, args: parsed.args });
      if (!alive()) return;
      await refresh();
      if (!alive()) return;
      if (result?.ok) showNotice({ tone: "success", message: label("added", { name, count: result.toolIds?.length ?? 0 }) });
      else await failure("add", result?.reason);
    } catch {
      if (!alive()) return;
      await refresh();
      await failure("add");
    } finally { finish(); }
  }

  async function setEnabled(server: McpServer, enabled: boolean, notice: "enabledNotice" | "reconnectedNotice" | "disabledNotice"): Promise<void> {
    const action = enabled ? "enable" : "disable";
    if (server.id === "playwright-mcp" || !begin()) return;
    try {
      if (!window.settings?.setMcpServerEnabled) { await failure(action); return; }
      invalidateRead();
      // Turning a server on asks for a native confirmation in Main that shows the exact command.
      const result = await window.settings.setMcpServerEnabled(server.id, enabled);
      if (!alive()) return;
      await refresh();
      if (!alive()) return;
      if (result?.ok) showNotice({ tone: "success", message: label(notice, { name: server.name, count: result.toolIds?.length ?? server.toolCount }) });
      else if ((result as { code?: string } | undefined)?.code !== "MCP_CANCELLED") await failure(action, result?.reason);
    } catch {
      if (!alive()) return;
      await refresh();
      await failure(action);
    } finally {
      finish();
      if (alive()) {
        // Rendering replaces the buttons: put focus back on this server's action, or on Refresh if it is gone.
        const target = [...list.querySelectorAll<HTMLButtonElement>("[data-mcp-action]")].find(button => button.dataset.mcpAction?.endsWith(`:${server.id}`));
        (target ?? refreshButton).focus();
      }
    }
  }

  async function remove(server: McpServer): Promise<void> {
    if (server.id === "playwright-mcp" || !begin()) return;
    try {
      const approved = await showConfirm({ tone: "warning", dangerous: true, title: label("removeTitle"), message: label("removeMessage", { name: server.name }), confirmText: label("remove"), cancelText: label("cancel") });
      if (!alive() || !approved) return;
      if (!window.settings?.removeMcpServer) { await failure("remove"); return; }
      invalidateRead();
      const result = await window.settings.removeMcpServer(server.id);
      if (!alive()) return;
      await refresh();
      if (!alive()) return;
      if (result?.ok) showNotice({ tone: "success", message: label("removed", { name: server.name }) });
      else await failure("remove");
    } catch {
      if (!alive()) return;
      // A disconnect can succeed while saving fails: re-read the actual state.
      await refresh();
      await failure("remove");
    } finally {
      finish();
      if (alive()) {
        // Rendering replaces row buttons. Restore focus after cancel/failure,
        // or to Refresh after a successful removal instead of leaving it on body.
        const target = [...list.querySelectorAll<HTMLButtonElement>("[data-mcp-remove]")]
          .find(button => button.dataset.mcpRemove === server.id);
        (target ?? refreshButton).focus();
      }
    }
  }

  const onRefresh = () => { if (!pending && !loading) void refresh(); };
  refreshButton.addEventListener("click", onRefresh);
  const unsubscribe = subscribeLocaleChanged(render);
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    readVersion++;
    unsubscribe();
    refreshButton.removeEventListener("click", onRefresh);
    window.removeEventListener("pagehide", dispose);
    window.removeEventListener("beforeunload", dispose);
  }
  window.addEventListener("pagehide", dispose);
  window.addEventListener("beforeunload", dispose);
  void refresh();
  return { add, dispose };
}
