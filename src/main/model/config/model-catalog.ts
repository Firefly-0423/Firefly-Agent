import type { ProviderProfile } from "./model-settings";

export interface SavedModelProfile extends ProviderProfile { id: string; provider: string; }

const trimmed = (text: string): string => text.trim();

/** 同一凭据指 密钥 / 模型名 / 接口地址 三者在去除首尾空白后完全一致。 */
export function sameModelCredential(left: SavedModelProfile, right: SavedModelProfile): boolean {
  const pairs: Array<[string, string]> = [
    [left.apiKey, right.apiKey],
    [left.model, right.model],
    [left.baseUrl, right.baseUrl],
  ];
  return pairs.every(([a, b]) => trimmed(a) === trimmed(b));
}

/** 加入一份档案；若与已有档案凭据相同则不加入，并返回 added 为 false。 */
export function addModelProfile(profiles: SavedModelProfile[], profile: SavedModelProfile): { profiles: SavedModelProfile[]; added: boolean } {
  const isDuplicate = profiles.some((item) => sameModelCredential(item, profile));
  return isDuplicate ? { profiles, added: false } : { profiles: [...profiles, profile], added: true };
}

/** 用新内容整体替换 id 相同的档案。找不到目标时返回 null。 */
export function updateModelProfile(profiles: SavedModelProfile[], profile: SavedModelProfile): SavedModelProfile[] | null {
  const hit = profiles.findIndex((item) => item.id === profile.id);
  if (hit === -1) { return null; }
  return profiles.map((item, slot) => (slot === hit ? profile : item));
}

/** 解析默认档案：优先按 id 查找，查不到则取列表第一项。 */
export function resolveDefaultModelProfile(profiles: SavedModelProfile[], defaultModelProfileId: string | undefined): SavedModelProfile | undefined {
  const wanted = profiles.find((item) => item.id === defaultModelProfileId);
  return wanted ?? profiles[0];
}
