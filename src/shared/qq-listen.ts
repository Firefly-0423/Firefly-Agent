/**
 * QQ（NapCat OneBot 反向 WebSocket）监听模式与鉴权预检的共享契约。
 * 监听地址是否回环、是否需要 Access Token 取决于本机网卡
 * （auto 模式遇到 WSL 虚拟网卡会解析成非回环地址），渲染进程拿不到这些信息，
 * 所以判定只能由主进程给出，渲染端不得自己复制判据，否则会漂移。
 */

/** 监听模式；渲染端只负责把用户的选择原样交给主进程 */
export type QqListenMode = "auto" | "loopback" | "wsl" | "custom";

/** 把存档值或表单值收敛为合法模式，缺省为 auto */
export function normalizeQqListenMode(value: unknown): QqListenMode {
  if (value === "loopback" || value === "wsl" || value === "custom") return value;
  return "auto";
}

/**
 * 主进程给出的鉴权预检结果。
 * ok 为 false 表示连监听地址都解析不出（如 wsl 模式却没有 WSL 网卡、
 * custom 模式地址为空），此时 error 可直接展示；
 * requiresAccessToken 只回答是否需要 token，不代表参数合法。
 */
export interface QqListenAuthRequirement {
  ok: boolean;
  requiresAccessToken: boolean;
  /** 解析出的实际监听地址（ok 时存在） */
  resolvedHost?: string;
  /** 实际生效的模式；auto 可能被解析为 wsl 或 loopback */
  resolvedMode?: QqListenMode;
  /** ok 为 false 时的原因 */
  error?: string;
}
