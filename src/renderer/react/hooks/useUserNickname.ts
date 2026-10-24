import { useState, useEffect } from "react";
import { resolveUserAddress } from "../../../shared/user-address";

type UserProfile = { callPreference?: string; nickname?: string };
type UserProfileApi = {
  onProfileChanged: (callback: (profile: UserProfile) => void) => () => void;
  getProfile: () => Promise<UserProfile | null>;
};
function userProfileApi(): UserProfileApi | undefined {
  const bridge = window as typeof window & { user?: UserProfileApi };
  return bridge.user;
}
function normalizeProfileField(profile: UserProfile | null | undefined, field: keyof UserProfile, fallback: string): string {
  const candidate = profile?.[field];
  if (typeof candidate !== "string") return fallback;
  return candidate.trim() ? candidate.trim() : fallback;
}
function useUserProfileField(field: keyof UserProfile, fallback: string): string {
  const [display, updateDisplay] = useState(fallback);
  useEffect(() => {
    let mounted = true;
    const bridge = userProfileApi();
    void bridge?.getProfile().then((fetched) => {
      if (mounted) updateDisplay(normalizeProfileField(fetched, field, fallback));
    }).catch(() => { if (mounted) updateDisplay(fallback); });
    const stop = bridge?.onProfileChanged((changed) => {
      if (mounted) updateDisplay(normalizeProfileField(changed, field, fallback));
    });
    return () => { mounted = false; stop?.(); };
  }, [fallback, field]);
  return display;
}

export function useUserNickname(): string {
  const nickname = useUserProfileField("nickname", "");
  return nickname;
}

export function useUserCallPreference(): string {
  const preferred = useUserProfileField("callPreference", "");
  const displayName = useUserNickname();
  return resolveUserAddress({ callPreference: preferred, nickname: displayName });
}
