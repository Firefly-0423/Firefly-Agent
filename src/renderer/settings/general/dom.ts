// General 面板的 DOM 引用。
// 从 settings.ts 拆分出来；这里用静态 ESM 导入，保证查询早于 settings.ts 顶层代码执行。

/** 按 id 取元素并断言类型；页面结构由 index.html 保证，这里不做空值兜底。 */
const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export const generalForm = byId<HTMLElement>("general-form");
export const languageSelect = byId<HTMLElement>("language-select");
export const segmentedChatEnabledInput = byId<HTMLInputElement>("segmented-chat-enabled");
export const proactiveChatSelect = byId<HTMLElement>("proactive-chat-select");
export const proactiveDeliveryRow = byId<HTMLElement>("proactive-delivery-row");
export const proactiveDeliverySelect = byId<HTMLElement>("proactive-delivery-select");
export const chatSocialContextEnabledInput = byId<HTMLInputElement>("chat-social-context-enabled");
export const toastSoundEnabledInput = byId<HTMLInputElement>("toast-sound-enabled");
export const launchAtLoginInput = byId<HTMLInputElement>("launch-at-login");
export const desktopSaveStatus = byId<HTMLElement>("desktop-save-status");
