export const DEFAULT_USER_ADDRESS = "开拓者";

export function resolveUserAddress(profile?: { callPreference?: string; nickname?: string } | null): string {
  return profile?.callPreference?.trim() || profile?.nickname?.trim() || DEFAULT_USER_ADDRESS;
}
