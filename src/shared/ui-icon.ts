export const UI_ICON_PRESETS = [
  { id: "firefly", label: "流萤", fileName: "firefly-avatar.png", previewPath: "../avatars/firefly-avatar.png" },
] as const;

export type UiIcon = typeof UI_ICON_PRESETS[number]["id"];

export function normalizeUiIcon(value: unknown): UiIcon {
  void value;
  return "firefly";
}
