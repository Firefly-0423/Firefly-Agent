import type { SavedProfileLite } from "./state";
import { getCustomEndpointMode } from "../custom-endpoint-state";
import { t } from "../i18n";

/** 卡片上的标签：与名称同一行的小号描边标记（自定义 / 默认）。 */
function appendTag(parent: HTMLElement, text: string, modifier?: string): void {
  const tag = document.createElement("span");
  tag.className = "provider-row__tag" + (modifier ? ` provider-row__tag--${modifier}` : "");
  tag.textContent = text;
  parent.append(tag);
}

/**
 * 每个已保存档案一张卡片：名称 + 标签 + 状态点，右侧“编辑 / 删除”；
 * 选中的卡片会由 mountProfileEditor 把编辑器挂在它里面。
 * Report stored configuration completeness; no connection test or network request.
 */
export function renderProviderRows(root: HTMLElement, profiles: readonly SavedProfileLite[], defaultId?: string, editingId?: string): void {
  root.replaceChildren();
  for (const [index, profile] of profiles.entries()) {
    const row = document.createElement("div");
    row.className = "provider-row" + (profile.id === editingId ? " is-active" : "");
    row.dataset.profileId = profile.id;
    const head = document.createElement("div");
    head.className = "provider-row__head";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.dataset.profileAction = "edit";
    copy.setAttribute("aria-controls", "profile-editor");
    copy.setAttribute("aria-expanded", String(profile.id === editingId));
    copy.setAttribute("aria-label", `${t("settings.providerUi.edit")} ${profile.displayName || profile.model}`);
    if (profile.id === editingId) copy.setAttribute("aria-current", "true");
    copy.className = "provider-row__copy";

    const incomplete = !profile.baseUrl.trim() || !profile.model.trim();
    const missingKey = !profile.apiKey.trim() && getCustomEndpointMode(profile.provider) !== "local";
    const title = document.createElement("span");
    title.className = "provider-row__title";
    const name = document.createElement("strong");
    name.className = "provider-row__name";
    name.textContent = profile.displayName || profile.provider;
    title.append(name);
    if (getCustomEndpointMode(profile.provider)) appendTag(title, t("settings.providerUi.tagCustom"));
    if (profile.id === defaultId) appendTag(title, t("settings.profile.badge.default"), "default");
    const dot = document.createElement("span");
    dot.className = "provider-row__dot";
    dot.dataset.state = incomplete || missingKey ? "missing" : "ok";
    dot.setAttribute("aria-hidden", "true");
    title.append(dot);

    const model = document.createElement("span");
    model.id = `provider-model-${index}`;
    model.className = "provider-row__model";
    model.textContent = `${profile.provider} · ${profile.model}`;
    const state = document.createElement("span");
    state.className = "provider-row__state";
    state.id = `provider-state-${index}`;
    copy.setAttribute("aria-describedby", `${model.id} ${state.id}`);
    state.textContent = incomplete
      ? t("settings.providerUi.incomplete")
      : missingKey
        ? t("settings.providerUi.missingKey")
        : t("settings.providerUi.configured");
    // 视觉上是卡片右侧的“编辑”描边小按钮；真正的按钮是整张卡片头部，保证整块可点、读屏只读一次。
    const chip = document.createElement("span");
    chip.className = "provider-row__chip";
    chip.setAttribute("aria-hidden", "true");
    chip.textContent = t("settings.providerUi.edit");
    const meta = document.createElement("span");
    meta.className = "provider-row__meta";
    meta.append(model, state);
    copy.append(title, meta, chip);

    const actions = document.createElement("div");
    actions.className = "provider-row__actions";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "provider-row__action";
    remove.dataset.profileAction = "delete";
    remove.textContent = t("settings.providerUi.delete");
    remove.setAttribute("aria-label", `${remove.textContent} ${profile.displayName || profile.model}`);
    actions.append(remove);
    head.append(copy, actions);
    row.append(head);
    root.append(row);
  }
}
