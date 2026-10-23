/**
 * 匿名公共浏览的账户 / 凭据 / 支付边界（Main 的导航校验与页面内 DOM 脚本共用同一份）。
 *
 * 只放「正则源码字符串」：DOM 脚本在隔离世界里用 new RegExp(source, flags) 重建，
 * 两处不会再各写一份而悄悄分叉。
 */

/** 账户认证、注册、会话、支付相关的路径段（整段匹配，可带常见脚本扩展名）。 */
const ACCOUNT_PATH_SEGMENTS = [
  "login", "log-in", "log_in", "logon", "wp-login", "signin", "sign-in", "sign_in",
  "signup", "sign-up", "sign_up", "join", "register", "registration",
  "logout", "log-out", "log_out", "signout", "sign-out", "sign_out",
  "session", "sessions", "oauth", "oauth2", "authorize", "auth", "sso", "saml",
  "password", "passwd", "forgot-password", "reset-password", "mfa", "2fa",
  "checkout", "payment", "payments", "billing", "wallet", "settings",
];
export const ACCOUNT_PATH_SOURCE =
  `(?:^|/)(?:${ACCOUNT_PATH_SEGMENTS.join("|")})(?:\\.(?:php|aspx?|jspx?|html?|do|action))?(?:/|$)`;

/** 凭据 / 支付 / 证件类输入框（匹配 name、id、autocomplete、aria-label、placeholder 拼起来的文本）。 */
export const SENSITIVE_FIELD_SOURCE = [
  "password", "passwd", "secret", "token", "credit", "card.?number", "security.?code", "one.?time", "otp",
  "social.?security", "cvv", "cvc", "csc", "iban", "routing.?number", "account.?number", "tax.?id",
  "national.?id", "passport", "api.?key", "private.?key", "seed.?phrase", "mnemonic", "recovery.?code",
  // 短词要求两侧不是字母，避免 "spinner"、"occupy" 之类误伤；cc-number / cc-csc 等 autocomplete 记号也由 cc 命中。
  "(?:^|[^a-z])(?:pin|ssn|cc)(?:[^a-z]|$)",
].join("|");

/** 按钮 / 链接文字：登录、注册、登出、支付与下单类动作不由代理点击。 */
export const ACCOUNT_ACTION_LABEL_SOURCE = [
  "sign[ -]?in", "log[ -]?in", "sign[ -]?up", "log[ -]?out", "sign[ -]?out",
  "check[ -]?out", "buy now", "purchase", "place order", "\\bpay(?:ment)?\\b",
  "登录", "登陆", "注册", "密码", "退出登录", "结算", "支付", "付款", "下单", "立即购买",
].join("|");

export function isAccountPath(pathname: string): boolean {
  return new RegExp(ACCOUNT_PATH_SOURCE, "i").test(pathname);
}
