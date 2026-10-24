import { useState, useEffect } from "react";

type UserAvatarApi = {
  onAvatarChanged: (callback: () => void) => () => void;
  getAvatar: () => Promise<string | null>;
};
function userAvatarApi(): UserAvatarApi | undefined {
  const bridge = window as typeof window & { user?: UserAvatarApi };
  return bridge.user;
}

export function useUserAvatar(): string | null {
  const [picture, showPicture] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    const bridge = userAvatarApi();
    async function refresh() {
      try {
        const fetched = await bridge?.getAvatar();
        if (mounted) showPicture(fetched ?? null);
      } catch { if (mounted) showPicture(null); }
    }
    void refresh();
    const stop = bridge?.onAvatarChanged(() => { void refresh(); });
    return () => { mounted = false; stop?.(); };
  }, []);
  return picture;
}
