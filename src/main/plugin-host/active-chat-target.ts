/**
 * 当前聊天目标登记表：记录聊天窗口正在查看的会话，以及渲染页面的目标标识。
 *
 * 语音输入租约借它冻结“提交目标”（会话 + 渲染页面）：
 * - 每次页面初始化都会生成新的 rendererTargetId；同一页面内切换会话不改变它，
 *   因此已取得的租约不会因切换会话而迁移或终止；
 * - 页面重载、主框架导航或 WebContents 销毁会让旧渲染桥失效：目标被清空，
 *   监听方收到通知并据此中止租约；
 * - 只有聊天窗口自己的 WebContents 能登记目标，sender 的校验由调用方负责。
 */
import { randomUUID } from "node:crypto";
import type { WebContents } from "electron";
import type { ConversationMode } from "../../shared/chat-types";

/** 目标快照：取得时复制一份，之后切换会话不会改动已拿到的值。 */
export interface ActiveChatTarget {
  sessionId: string;
  mode: ConversationMode;
  rendererTargetId: string;
  webContentsId: number;
}

export type ActiveChatTargetInvalidReason =
  | "target-destroyed"
  | "navigation"
  | "session-deleted";

export interface ActiveChatTargetRegistry {
  /** 渲染端上报活动会话（首次或切换）。sender 须是聊天窗口的 WebContents。 */
  setActive(input: {
    sender: WebContents;
    sessionId: string;
    mode: ConversationMode;
    rendererTargetId: string;
  }): void;
  /** 渲染端清空活动会话（回到欢迎页）。 */
  clearActive(sender: WebContents): void;
  /** 返回当前目标的快照；没有目标时为 null。 */
  getActive(): ActiveChatTarget | null;
  /**
   * 订阅目标失效事件（WebContents 销毁、主框架导航、当前会话被删除）。
   * affected 是失效之前的目标快照，没有目标时为 null。
   */
  onInvalidated(
    listener: (reason: ActiveChatTargetInvalidReason, affected: ActiveChatTarget | null) => void,
  ): () => void;
  /**
   * 订阅任意会话被删除的事件，不区分是否为当前目标。
   * 冻结了该会话的租约靠它中止，即使页面已经切到别的会话。
   */
  onSessionDeleted(listener: (sessionId: string) => void): () => void;
  /** 会话被删除时调用（chats-ipc 删除路径）；若删的是当前目标会话，目标随之失效。 */
  notifySessionDeleted(sessionId: string): void;
  /** 注销全部监听并清空目标，应用退出时调用。 */
  dispose(): void;
}

const KNOWN_MODES: readonly string[] = ["chat", "work", "code"];

/** 校验渲染端上报的目标字段。格式不合法返回 null，调用方应忽略这次上报。 */
export function parseActiveTargetPayload(
  payload: unknown,
): { sessionId: string; mode: ConversationMode; rendererTargetId: string } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const candidate = payload as { sessionId?: unknown; mode?: unknown; rendererTargetId?: unknown };
  const { sessionId, mode, rendererTargetId } = candidate;
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  if (typeof mode !== "string" || !KNOWN_MODES.includes(mode)) return null;
  if (typeof rendererTargetId !== "string" || rendererTargetId.length === 0) return null;
  return { sessionId, mode: mode as ConversationMode, rendererTargetId };
}

type InvalidatedListener = (
  reason: ActiveChatTargetInvalidReason,
  affected: ActiveChatTarget | null,
) => void;

export function createActiveChatTargetRegistry(): ActiveChatTargetRegistry {
  const invalidatedSubscribers = new Set<InvalidatedListener>();
  const deletionSubscribers = new Set<(sessionId: string) => void>();
  let snapshot: ActiveChatTarget | null = null;
  // 当前挂着失效监听的 WebContents。同一页面里切换会话时不重复挂载。
  let attachedTo: WebContents | null = null;
  let closed = false;

  function broadcastInvalidated(
    reason: ActiveChatTargetInvalidReason,
    affected: ActiveChatTarget | null,
  ): void {
    for (const subscriber of [...invalidatedSubscribers]) {
      try {
        subscriber(reason, affected);
      } catch (failure) {
        console.warn("[active-chat-target] 失效监听器抛错", failure);
      }
    }
  }

  function unhook(): void {
    if (!attachedTo) return;
    attachedTo.removeListener("destroyed", onTargetDestroyed);
    attachedTo.removeListener("did-start-navigation", onTargetNavigated);
    attachedTo = null;
  }

  function onTargetDestroyed(): void {
    const dropped = snapshot;
    snapshot = null;
    attachedTo = null;
    broadcastInvalidated("target-destroyed", dropped);
  }

  function onTargetNavigated(
    _event: unknown,
    _url: string,
    _isInPlace: boolean,
    isMainFrame: boolean,
  ): void {
    // 只关心主框架导航。页内锚点或子框架跳转不算重载，旧渲染桥依然有效。
    if (!isMainFrame) return;
    const dropped = snapshot;
    snapshot = null;
    broadcastInvalidated("navigation", dropped);
  }

  return {
    setActive({ sender, sessionId, mode, rendererTargetId }) {
      if (closed || sender.isDestroyed()) return;
      if (attachedTo !== sender) {
        // 首次登记，或页面已重新加载：挂上新页面的失效监听。
        unhook();
        attachedTo = sender;
        sender.once("destroyed", onTargetDestroyed);
        // 必须用 on 而不是 once：同文档或子框架导航不应消耗掉这个监听。
        sender.on("did-start-navigation", onTargetNavigated);
      }
      snapshot = { sessionId, mode, rendererTargetId, webContentsId: sender.id };
    },

    clearActive(sender) {
      if (closed) return;
      if (snapshot && snapshot.webContentsId === sender.id) {
        snapshot = null;
      }
    },

    getActive() {
      return snapshot ? { ...snapshot } : null;
    },

    onInvalidated(listener) {
      invalidatedSubscribers.add(listener);
      return () => {
        invalidatedSubscribers.delete(listener);
      };
    },

    notifySessionDeleted(sessionId) {
      if (closed) return;
      // 不论是否为当前目标都要通知：冻结了该会话的租约靠这条通知中止。
      for (const subscriber of [...deletionSubscribers]) {
        try {
          subscriber(sessionId);
        } catch (failure) {
          console.warn("[active-chat-target] 会话删除监听器抛错", failure);
        }
      }
      if (snapshot && snapshot.sessionId === sessionId) {
        const dropped = snapshot;
        snapshot = null;
        broadcastInvalidated("session-deleted", dropped);
      }
    },

    onSessionDeleted(listener) {
      deletionSubscribers.add(listener);
      return () => {
        deletionSubscribers.delete(listener);
      };
    },

    dispose() {
      if (closed) return;
      closed = true;
      unhook();
      snapshot = null;
      invalidatedSubscribers.clear();
      deletionSubscribers.clear();
    },
  };
}

/** 生成渲染目标标识。preload 在每次页面初始化时调用一次。 */
export function generateRendererTargetId(): string {
  return randomUUID();
}

/** 进程内唯一的登记表：chat-ui-ipc 上报与主进程的浏览器宿主授权共用它。 */
export const activeChatTargetRegistry = createActiveChatTargetRegistry();
