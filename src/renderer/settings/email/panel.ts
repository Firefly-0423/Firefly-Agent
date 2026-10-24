import {
  emailEnabledCheckbox, emailConfig, emailSmtpHostInput, emailSmtpPortInput,
  emailSmtpSecureInput, emailSmtpUserInput, emailSmtpPassInput, emailFromNameInput,
} from "./dom";
import { pluginsState } from "../plugins/state";

export function syncEmailConfigVisibility(): void {
  if (!emailConfig) return;
  emailConfig.style.display = emailEnabledCheckbox?.checked ? "block" : "none";
}

export async function saveEmailField(field: string, value: unknown): Promise<void> {
  if (window.settings) {
    try {
      await window.settings?.saveGeneral({ [field]: value });
    } catch (failure) {
      console.warn("[plugins] 保存邮件配置失败:", field, failure);
    }
  }
}

export async function loadEmailConfig(): Promise<void> {
  try {
    const stored = await window.settings?.getGeneral();
    if (stored) {
      if (emailEnabledCheckbox) emailEnabledCheckbox.checked = Boolean(stored.emailEnabled);
      if (emailSmtpHostInput) emailSmtpHostInput.value = String(stored.emailSmtpHost ?? "");
      if (emailSmtpPortInput) emailSmtpPortInput.value = String(stored.emailSmtpPort ?? 465);
      if (emailSmtpSecureInput) emailSmtpSecureInput.checked = Boolean(stored.emailSmtpSecure);
      if (emailSmtpUserInput) emailSmtpUserInput.value = String(stored.emailSmtpUser ?? "");
      if (emailSmtpPassInput) emailSmtpPassInput.value = String(stored.emailSmtpPass ?? "");
      if (emailFromNameInput) emailFromNameInput.value = String(stored.emailFromName ?? "");
    }
    syncEmailConfigVisibility();
  } catch (failure) {
    console.warn("[plugins] 加载邮件配置失败", failure);
  }
}

type MailTimer = "emailSmtpHostTimer" | "emailSmtpPortTimer" | "emailSmtpUserTimer" | "emailSmtpPassTimer" | "emailFromNameTimer";
function bindMailInput(input: HTMLInputElement | null, timer: MailTimer, field: string, read: (element: HTMLInputElement) => unknown): void {
  input?.addEventListener("input", function () {
    clearTimeout(pluginsState[timer]);
    pluginsState[timer] = setTimeout(() => { void saveEmailField(field, read(this)); }, 800);
  });
}

emailEnabledCheckbox?.addEventListener("change", function () {
  syncEmailConfigVisibility();
  void saveEmailField("emailEnabled", this.checked);
});
// 每个字段独立防抖，到时读取最新输入。
bindMailInput(emailSmtpHostInput, "emailSmtpHostTimer", "emailSmtpHost", element => element.value.trim());
bindMailInput(emailSmtpPortInput, "emailSmtpPortTimer", "emailSmtpPort", element => Number(element.value) || 465);
emailSmtpSecureInput?.addEventListener("change", function () {
  void saveEmailField("emailSmtpSecure", this.checked);
});
bindMailInput(emailSmtpUserInput, "emailSmtpUserTimer", "emailSmtpUser", element => element.value.trim());
bindMailInput(emailSmtpPassInput, "emailSmtpPassTimer", "emailSmtpPass", element => element.value.trim());
bindMailInput(emailFromNameInput, "emailFromNameTimer", "emailFromName", element => element.value.trim());
void loadEmailConfig();
