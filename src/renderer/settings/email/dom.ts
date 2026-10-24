// 元素在模块加载时绑定，空值约定由各面板决定。
function control<T extends HTMLElement | null>(id: string): T {
  return document.getElementById(id) as T;
}

export const emailEnabledCheckbox = control<HTMLInputElement | null>("plugin-email-enabled");
export const emailConfig = control<HTMLElement | null>("plugin-email-config");
export const emailSmtpHostInput = control<HTMLInputElement | null>("email-smtp-host");
export const emailSmtpPortInput = control<HTMLInputElement | null>("email-smtp-port");
export const emailSmtpSecureInput = control<HTMLInputElement | null>("email-smtp-secure");
export const emailSmtpUserInput = control<HTMLInputElement | null>("email-smtp-user");
export const emailSmtpPassInput = control<HTMLInputElement | null>("email-smtp-pass");
export const emailFromNameInput = control<HTMLInputElement | null>("email-from-name");
