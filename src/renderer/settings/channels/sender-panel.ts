// 微信、飞书的发送者放行设置：放行开关、白名单，以及等待批准的陌生发送者。
// 控件由本模块生成并挂到 #channels-<channel>-senders，不依赖 dom.ts 的静态引用。
import type { SettingsApi } from "../shared/types";

type SenderChannel = "wechat" | "feishu";

interface PendingSender {
  senderId: string;
  senderName?: string;
  at: number;
}

interface SenderConfig {
  allowAnyPrivate?: boolean;
  allowedSenderIds?: string[];
}

const CHANNELS: Array<{ id: SenderChannel; idHint: string }> = [
  { id: "wechat", idHint: "形如 xxxx@im.wechat" },
  { id: "feishu", idHint: "形如 ou_xxxx（open_id）" },
];

/** 与主进程 normalizeSenderIds 的格式一致。 */
export function parseSenderIds(value: string): string[] {
  return Array.from(new Set(
    value.split(/[\s,，]+/u)
      .map((item) => item.trim())
      .filter((item) => /^[A-Za-z0-9@._:=-]{1,128}$/u.test(item)),
  ));
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatTime(at: number): string {
  const date = new Date(at);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("zh-CN", { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";
}

interface ChannelControls {
  allowAny: HTMLInputElement;
  warning: HTMLElement;
  allowlist: HTMLTextAreaElement;
  pending: HTMLElement;
  feedback: HTMLElement;
}

function buildChannel(root: HTMLElement, idHint: string): ChannelControls {
  root.replaceChildren();

  const title = el("div", "form-label", "谁可以给她发消息");
  const hint = el(
    "p",
    "channels-card__hint",
    "默认只有你批准过的人才能和她对话。陌生人第一次发来消息时不会得到回复，会出现在下面的待批准列表里。",
  );

  const allowRow = el("div", "form-row");
  const allowLabel = el("label", "form-label", "放行所有人");
  const allowSwitch = el("span", "switch");
  const allowAny = el("input");
  allowAny.type = "checkbox";
  allowSwitch.append(allowAny, el("span", "switch__track"));
  allowSwitch.querySelector(".switch__track")!.append(el("span", "switch__thumb"));
  allowRow.append(allowLabel, allowSwitch);

  const warning = el(
    "p",
    "channels-feedback channels-feedback--err",
    "已放行所有人：任何能给这个账号发消息的人都会触发她回复。建议关闭，并只批准你认识的人。",
  );
  warning.hidden = true;

  const listRow = el("div", "form-row");
  listRow.append(el("label", "form-label", "白名单"));
  const allowlist = el("textarea", "form-input form-input--wide");
  allowlist.rows = 3;
  allowlist.placeholder = `每行一个，${idHint}`;
  listRow.append(allowlist);

  const actions = el("div", "channels-card__actions");
  const save = el("button", "btn-secondary", "保存白名单");
  save.type = "button";
  actions.append(save);

  const pending = el("div", "channels-context-bindings");
  const feedback = el("div", "channels-feedback");

  root.append(title, hint, allowRow, warning, listRow, actions, el("div", "form-label", "待批准"), pending, feedback);

  allowAny.addEventListener("change", () => {
    warning.hidden = !allowAny.checked;
  });
  // 保存按钮由 initSenderPanels 绑定；通过 dataset 标记便于挂接。
  save.dataset.role = "save";
  return { allowAny, warning, allowlist, pending, feedback };
}

export interface SenderPanelHandle {
  /** 用最新的渠道状态刷新待批准列表。 */
  renderStatus(status: unknown): void;
  /** 用保存的配置回填开关与白名单。 */
  fillConfig(config: unknown): void;
}

export function initSenderPanels(settings: SettingsApi): SenderPanelHandle {
  const controls = new Map<SenderChannel, ChannelControls>();

  const setFeedback = (channel: SenderChannel, kind: "ok" | "err" | "info", message: string) => {
    const node = controls.get(channel)?.feedback;
    if (!node) return;
    node.textContent = message;
    node.className = `channels-feedback channels-feedback--${kind}`;
  };

  const fill = (channel: SenderChannel, config: SenderConfig | undefined) => {
    const c = controls.get(channel);
    if (!c) return;
    c.allowAny.checked = !!config?.allowAnyPrivate;
    c.warning.hidden = !c.allowAny.checked;
    c.allowlist.value = (config?.allowedSenderIds ?? []).join("\n");
  };

  const renderPending = (channel: SenderChannel, pending: PendingSender[]) => {
    const c = controls.get(channel);
    if (!c) return;
    c.pending.replaceChildren();
    if (pending.length === 0) {
      c.pending.append(el("p", "empty-hint", "暂无待批准的发送者。"));
      return;
    }
    for (const item of pending) {
      const row = el("div", "channels-context-binding");
      // 名称与标识来自陌生人，只以纯文本显示。
      const label = el("span", undefined, `${item.senderName ? `${item.senderName} · ` : ""}${item.senderId} · ${formatTime(item.at)}`);
      const buttons = el("span", "channels-card__actions");
      const approve = el("button", "btn-secondary", "批准");
      const dismiss = el("button", "btn-secondary", "忽略");
      approve.type = "button";
      dismiss.type = "button";
      const resolve = async (action: "approve" | "dismiss") => {
        approve.disabled = true;
        dismiss.disabled = true;
        try {
          const result = await settings.channelsSenderResolve({ channel, senderId: item.senderId, action });
          if (!result.ok) throw new Error(result.error ?? "操作失败");
          if (action === "approve") {
            fill(channel, (await settings.channelsGetConfig())?.[channel]);
            setFeedback(channel, "ok", "已批准，对方之后发来的消息会正常回复。");
          }
        } catch (err) {
          approve.disabled = false;
          dismiss.disabled = false;
          setFeedback(channel, "err", err instanceof Error ? err.message : String(err));
        }
      };
      approve.addEventListener("click", () => void resolve("approve"));
      dismiss.addEventListener("click", () => void resolve("dismiss"));
      buttons.append(approve, dismiss);
      row.append(label, buttons);
      c.pending.append(row);
    }
  };

  for (const { id, idHint } of CHANNELS) {
    const root = document.getElementById(`channels-${id}-senders`);
    if (!root) continue;
    const c = buildChannel(root, idHint);
    controls.set(id, c);
    renderPending(id, []);
    root.querySelector<HTMLButtonElement>('button[data-role="save"]')?.addEventListener("click", async () => {
      setFeedback(id, "info", "保存中…");
      try {
        await settings.channelsSaveConfig({
          [id]: { allowAnyPrivate: c.allowAny.checked, allowedSenderIds: parseSenderIds(c.allowlist.value) },
        });
        setFeedback(id, "ok", "白名单已保存。");
      } catch (err) {
        setFeedback(id, "err", err instanceof Error ? err.message : String(err));
      }
    });
  }

  return {
    fillConfig(config) {
      const record = (config ?? {}) as Partial<Record<SenderChannel, SenderConfig>>;
      for (const { id } of CHANNELS) fill(id, record[id]);
    },
    renderStatus(status) {
      const record = (status ?? {}) as Partial<Record<SenderChannel, { detail?: { pendingSenders?: PendingSender[] } }>>;
      for (const { id } of CHANNELS) {
        const pending = record[id]?.detail?.pendingSenders;
        renderPending(id, Array.isArray(pending) ? pending : []);
      }
    },
  };
}
