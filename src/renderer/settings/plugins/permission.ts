import { permissionBlocksWrap, permissionNote } from "./dom";
import { _initModalOverlay } from "../shared/modal";
import { modalState } from "../shared/modal-state";

type PermissionLevel = "project-read-only" | "read-only" | "scoped" | "per-action" | "full";
const PERMISSION_NOTES: Record<PermissionLevel, string> = {
  "project-read-only": "完全只读：流萤只能在当前项目目录内只读，不能修改任何文件，也不能执行命令。",
  "read-only": "只读：流萤不会修改本地任何文件，也不能为你安装新工具。",
  scoped: "指定目录：流萤只能在你授权的目录里读写文件（白名单后续在此面板配置）。",
  "per-action": "每次审批：每次涉及文件或安装的操作，流萤都会在聊天里弹卡片让你确认。",
  full: "完全访问：流萤可以自由调用本地命令（含 git/npm/pip）。请只在你完全信任的情况下使用。",
};
function paintPermissionUI(level: PermissionLevel): void {
  if (!permissionBlocksWrap) return;
  const visibleLevel = level === "scoped" ? "read-only" : level;
  permissionBlocksWrap.querySelectorAll<HTMLButtonElement>("button[data-level]").forEach(button => {
    const selected = button.dataset.level === visibleLevel;
    button.classList.toggle("is-active", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  if (permissionNote) permissionNote.textContent = PERMISSION_NOTES[level];
}

async function confirmFullAccess(): Promise<boolean> {
  _initModalOverlay();
  if (!modalState.ffOverlay) return false;
  const symbol = modalState.ffOverlay.querySelector("#ff-modal-icon") as HTMLElement;
  const heading = modalState.ffOverlay.querySelector("#ff-modal-title") as HTMLElement;
  const description = modalState.ffOverlay.querySelector("#ff-modal-message") as HTMLElement;
  const cancel = modalState.ffOverlay.querySelector("#ff-modal-cancel") as HTMLButtonElement;
  const confirm = modalState.ffOverlay.querySelector("#ff-modal-confirm") as HTMLButtonElement;
  symbol.textContent = "⚠️";
  heading.textContent = "切换到完全访问？";
  description.textContent = "这意味着流萤可以在你的电脑上自由执行命令，包括 git clone、npm install、删除文件等。请只在你完全信任她的判断时启用。";
  cancel.textContent = "再想想";
  modalState.ffOverlay.classList.remove("is-hidden");
  let seconds = 5;
  confirm.disabled = true;
  confirm.textContent = "我了解风险（" + seconds + "）";
  const countdown = setInterval(() => {
    seconds -= 1;
    if (seconds <= 0) {
      confirm.disabled = false;
      confirm.textContent = "我了解风险，启用";
      clearInterval(countdown);
    } else {
      confirm.textContent = "我了解风险（" + seconds + "）";
    }
  }, 1000);
  return new Promise(resolve => {
    const finish = (accepted: boolean): void => {
      clearInterval(countdown);
      confirm.disabled = false;
      modalState.ffOverlay?.classList.add("is-hidden");
      cancel.removeEventListener("click", decline);
      confirm.removeEventListener("click", accept);
      resolve(accepted);
    };
    const decline = (): void => finish(false);
    const accept = (): void => finish(true);
    cancel.addEventListener("click", decline);
    confirm.addEventListener("click", accept);
  });
}

async function changePermission(event: Event): Promise<void> {
  const pressed = (event.target as HTMLElement)?.closest("button[data-level]") as HTMLButtonElement | null;
  if (!pressed) return;
  const requested = (pressed.dataset.level || "") as PermissionLevel;
  if (!requested) return;
  if (pressed.classList.contains("is-active")) {
    console.log("[settings] 档位未变，不动作");
    return;
  }
  if (requested === "full") {
    const accepted = await confirmFullAccess();
    if (!accepted) {
      console.log("[settings] 用户取消了完全访问");
      return;
    }
  }
  console.log("[settings] 切换权限档位 →", requested);
  try {
    const saved = await window.settings?.setPermissionLevel?.(requested);
    if (saved?.ok) paintPermissionUI((saved.level || requested) as PermissionLevel);
    else console.warn("[settings] 切换档位失败:", saved?.error);
  } catch (failure) {
    console.error("[settings] 切换档位异常:", failure);
  }
}
async function loadPermission(): Promise<void> {
  try {
    const saved = await window.settings?.getPermissionLevel?.();
    const selected = (saved?.level || "read-only") as PermissionLevel;
    console.log("[settings] 当前权限档位:", selected);
    paintPermissionUI(selected);
  } catch (failure) {
    console.warn("[settings] 加载权限档位失败:", failure);
    paintPermissionUI("read-only");
  }
}
if (permissionBlocksWrap) {
  permissionBlocksWrap.addEventListener("click", changePermission);
  void loadPermission();
}