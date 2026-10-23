/**
 * 编辑器内的“连接”分区：API Key 始终在主区；预设厂商的昵称 / Base URL / 协议收进“自定义设置”，
 * 自定义 API 则全部直接展开。只移动原节点，值、监听器与保存语义都不变。
 * 模型名 / 上下文窗口 / 推理档位固定在“模型”分区，不随厂商类型移动。
 *
 * editing=true 表示正在编辑已保存的档案：厂商预设卡只用于“新建”，此时隐藏。
 */
export function applyProviderEditorLayout(root: HTMLElement, kind: "preset" | "custom", editing = false): void {
  const primary = root.querySelector<HTMLElement>("#provider-primary-fields");
  const more = root.querySelector<HTMLElement>("#provider-connection-more-fields");
  if (!primary || !more) return;
  const fields = ["display-name", "api-key", "base-url", "transport-select"]
    .map(id => root.querySelector<HTMLElement>(`#${id}`)?.closest<HTMLElement>("[data-provider-field]"))
    .filter((field): field is HTMLElement => Boolean(field));
  for (const field of fields) {
    const basic = field.dataset.providerField === "key" || kind === "custom";
    (basic ? primary : more).append(field);
  }
  const moreGroup = root.querySelector<HTMLElement>("#provider-connection-more");
  if (moreGroup) moreGroup.hidden = kind === "custom";
  const presets = root.querySelector<HTMLElement>("#provider-preset-page");
  if (presets) presets.hidden = kind !== "preset" || editing;
  root.querySelectorAll<HTMLButtonElement>("[data-provider-tab]").forEach(button => {
    const selected = button.dataset.providerTab === kind;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
}

/**
 * 编辑器的落点：编辑已保存档案时挂进该档案的卡片；新建（或没有可挂的卡片）时放回列表下方的占位容器。
 * 列表重绘会清空卡片，所以重绘前先 parkProfileEditor，重绘后再 mountProfileEditor。
 * 移动节点会让浏览器丢掉焦点，这里按需恢复。
 */
export function mountProfileEditor(root: HTMLElement, editingProfileId: string | undefined): void {
  const editor = root.querySelector<HTMLElement>("#profile-editor");
  const slot = root.querySelector<HTMLElement>("#provider-editor-slot");
  if (!editor || !slot) return;
  const card = editingProfileId
    ? Array.from(root.querySelectorAll<HTMLElement>("#model-profile-list > [data-profile-id]"))
      .find(row => row.dataset.profileId === editingProfileId)
    : undefined;
  const host = card ?? slot;
  if (editor.parentElement === host && host.lastElementChild === editor) return;
  const focused = editor.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  host.append(editor);
  focused?.focus();
}

/** 列表重绘前把编辑器放回占位容器，避免它跟着旧卡片一起被清掉。 */
export function parkProfileEditor(root: HTMLElement): void {
  const editor = root.querySelector<HTMLElement>("#profile-editor");
  const slot = root.querySelector<HTMLElement>("#provider-editor-slot");
  if (!editor || !slot || editor.parentElement === slot) return;
  slot.append(editor);
}

/** 重绘卡片列表并让编辑器（连同其中的焦点与草稿）留在原位。 */
export function renderKeepingProfileEditor(root: HTMLElement, editingProfileId: string | undefined, render: () => void): void {
  const editor = root.querySelector<HTMLElement>("#profile-editor");
  const focused = editor?.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  parkProfileEditor(root);
  render();
  mountProfileEditor(root, editingProfileId);
  focused?.focus();
}

/** 保存状态条跟着编辑器走：编辑器打开时贴在底部按钮旁，关闭后回到列表上方。 */
export function placeSaveStatus(root: HTMLElement, editorOpen: boolean): void {
  const status = root.querySelector<HTMLElement>("#save-status");
  const host = root.querySelector<HTMLElement>(editorOpen ? "#provider-status-slot" : "#provider-status-top");
  if (status && host && status.parentElement !== host) host.append(status);
}
