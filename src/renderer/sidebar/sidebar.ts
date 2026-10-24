import "../ui/base.css";
import "./sidebar.css";
import "../ui/theme";

type ModelConfig = {
  connected: boolean;
  model: string;
  shortName: string;
  displayName?: string;
  provider: string;
  mode: "auto" | "manual";
}
interface SidebarApi {
  openSettings: (section?: string) => void;
  toggleAlwaysOnTop: () => Promise<boolean>;
  close: () => void;
  minimize: () => void;
}
declare global { interface Window { sidebar?: SidebarApi; } }
if (!window.sidebar) {
  (window as unknown as { sidebar: SidebarApi }).sidebar = {
    minimize: function () {},
    close: function () {},
    toggleAlwaysOnTop: () => Promise.resolve(false),
    openSettings: (_tab?: string) => {},
  };
}
const panel = document.querySelector(".sidebar") as HTMLElement | null;
const minimizeButton = document.getElementById("min-btn") as HTMLButtonElement;
const exitButton = document.getElementById("close-btn") as HTMLButtonElement;
const topButton = document.getElementById("pin-btn") as HTMLButtonElement;
const preferencesButton = document.getElementById("settings-btn") as HTMLButtonElement;
const modelButton = document.getElementById("model-switch-btn") as HTMLButtonElement;
const chatButton = document.getElementById("open-chat-btn") as HTMLButtonElement;
const connectionLabel = document.getElementById("online-status-label") as HTMLElement;
const connectionBadge = connectionLabel.closest(".profile__online") as HTMLElement | null;

function applyModelConfig(value: ModelConfig | null): void {
  const online = Boolean(value?.connected);
  connectionLabel.textContent = online ? "在线" : "离线";
  connectionBadge?.classList.toggle("is-offline", !online);
}
async function initModelConfig(): Promise<void> {
  try {
    const initial = await window.modelConfig?.get();
    applyModelConfig(initial ?? null);
  } catch { applyModelConfig(null); }
  window.modelConfig?.onChanged((value) => applyModelConfig(value));
}

topButton.addEventListener("click", async () => {
  const response = await window.sidebar?.toggleAlwaysOnTop();
  const active = Boolean(response);
  topButton.classList.toggle("is-active", active);
  topButton.setAttribute("aria-label", active ? "取消置顶" : "置顶");
  topButton.setAttribute("title", active ? "取消置顶" : "置顶");
});
minimizeButton.addEventListener("click", () => { window.sidebar?.minimize(); });
exitButton.addEventListener("click", () => { window.sidebar?.close(); });
preferencesButton.addEventListener("click", () => { window.sidebar?.openSettings(); });
modelButton.addEventListener("click", () => { window.sidebar?.openSettings("api"); });
chatButton.addEventListener("click", async () => {
  const storage = (window as unknown as { chatStore?: {
    list: () => Promise<Array<{ id: string }>>;
    create: (payload?: { identityId?: string | null }) => Promise<{ id: string } | null>;
    openInReactChatWindow: (sessionId: string) => Promise<unknown>;
  } }).chatStore;
  if (!storage) return;
  try {
    const sessions = await storage.list();
    let selected = sessions.length > 0 ? sessions[0].id : "";
    if (!selected) {
      const fresh = await storage.create({ identityId: null });
      selected = fresh?.id ?? "";
    }
    if (selected) await storage.openInReactChatWindow(selected);
  } catch (failure) { console.warn("[sidebar] 打开聊天失败:", failure); }
});
void initModelConfig();
