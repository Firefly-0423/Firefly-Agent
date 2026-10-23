// 用户信息页的“账号”卡片：云端账号的本地状态预留。
//
// 现状：还没有云端账号后端，也没有任何登录 / 注册接口。这里只提供
//   - 状态类型 AccountState；
//   - 集中的状态来源 getAccountState()（当前恒为 signed-out）；
//   - 纯函数 buildAccountCardView()：状态 -> 视图模型，便于单测；
//   - renderAccountCardDom()：把视图模型写到账号卡片 DOM 上（按 id 查询，不缓存元素）。
// 不写入存储、不新增 IPC、不调用任何网络接口，也不会出现假的登录成功。
// 将来接入云端账号服务时，只需替换 getAccountState() 的来源，视图与 DOM 绑定保持不变。

import { t } from "../i18n";

export type AccountState =
  | { status: "signed-out" }
  | { status: "signed-in"; displayName: string; email?: string; avatarUrl?: string };

export interface AccountCardView {
  status: AccountState["status"];
  /** 登录态下的账号名；null 表示没有可用名称，DOM 层显示“未命名账号”占位。 */
  displayName: string | null;
  /** 登录态下的邮箱；缺省为 null，DOM 层隐藏该行。 */
  email: string | null;
  /** 头像地址，只接受 https；缺省或不合法为 null，DOM 层显示默认头像占位。 */
  avatarUrl: string | null;
  /** 登录 / 注册按钮：云端账号服务尚未开放，始终禁用。 */
  loginDisabled: boolean;
}

/**
 * 当前账号状态的唯一来源。
 * 云端账号服务接入前恒为未登录；不要在这里读写存储或伪造登录成功。
 */
export function getAccountState(): AccountState {
  return { status: "signed-out" };
}

function trimOrNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function safeAvatarUrl(raw: string | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** 状态 -> 视图模型（纯函数，不碰 DOM）。 */
export function buildAccountCardView(state: AccountState): AccountCardView {
  if (state.status !== "signed-in") {
    return { status: "signed-out", displayName: null, email: null, avatarUrl: null, loginDisabled: true };
  }
  return {
    status: "signed-in",
    displayName: trimOrNull(state.displayName),
    email: trimOrNull(state.email),
    avatarUrl: safeAvatarUrl(state.avatarUrl),
    loginDisabled: true,
  };
}

/** 把视图模型写到账号卡片上。元素不存在时静默跳过（例如测试里只挂了部分 DOM）。 */
export function renderAccountCardDom(view: AccountCardView, root: ParentNode = document): void {
  const signedIn = view.status === "signed-in";

  const signedOutRow = root.querySelector<HTMLElement>("#account-signed-out");
  if (signedOutRow) signedOutRow.hidden = signedIn;
  const signedInRow = root.querySelector<HTMLElement>("#account-signed-in");
  if (signedInRow) signedInRow.hidden = !signedIn;

  const loginButton = root.querySelector<HTMLButtonElement>("#account-login-btn");
  if (loginButton) loginButton.disabled = view.loginDisabled;

  const nameEl = root.querySelector<HTMLElement>("#account-display-name");
  if (nameEl) {
    nameEl.textContent = signedIn ? view.displayName ?? t("settings.panel.user.account.unnamed") : "";
  }

  const emailEl = root.querySelector<HTMLElement>("#account-email");
  if (emailEl) {
    emailEl.textContent = signedIn ? view.email ?? "" : "";
    emailEl.hidden = !signedIn || !view.email;
  }

  const avatarUrl = signedIn ? view.avatarUrl : null;
  const avatarImg = root.querySelector<HTMLImageElement>("#account-avatar-img");
  if (avatarImg) {
    if (avatarUrl) avatarImg.src = avatarUrl;
    else avatarImg.removeAttribute("src");
    avatarImg.hidden = !avatarUrl;
  }
  const avatarPlaceholder = root.querySelector<HTMLElement>("#account-avatar-placeholder");
  if (avatarPlaceholder) avatarPlaceholder.hidden = Boolean(avatarUrl);
}
