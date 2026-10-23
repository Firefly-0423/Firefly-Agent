import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatSessionMeta } from "../../../../../shared/chat-types";
import type { SidebarLayoutApi, SidebarPatch, SidebarSnapshot } from "../../../../../shared/sidebar-layout";

/** Server snapshots own placement. Mutations serialize with the latest revision;
 * a conflict refreshes the projection and leaves the rejected intent unapplied. */
export function useSidebarLayout(api: SidebarLayoutApi | undefined, sessions: readonly ChatSessionMeta[]) {
  const [snapshot, setSnapshot] = useState<SidebarSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const current = useRef<SidebarSnapshot | null>(null);
  const alive = useRef(false);
  const loads = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const adopt = useCallback((next: SidebarSnapshot) => {
    if (!alive.current || (current.current && next.layout.revision < current.current.layout.revision)) return;
    current.current = next; setSnapshot(next);
  }, []);
  const refresh = useCallback(async () => {
    if (!api) return;
    const generation = ++loads.current;
    try {
      const reply = await api.get();
      if (!alive.current || generation !== loads.current) return;
      if (reply.ok) { adopt(reply.snapshot); setError(null); }
      else setError(reply.code);
    } catch { if (alive.current && generation === loads.current) setError("storage_error"); }
  }, [api, adopt]);
  useEffect(() => {
    alive.current = true;
    const off = api?.onChanged(() => { void refresh(); });
    return () => { alive.current = false; ++loads.current; off?.(); };
  }, [api, refresh]);
  useEffect(() => { void refresh(); }, [refresh, sessions]);
  const mutate = useCallback((patch: SidebarPatch) => {
    const result = queue.current.then(async () => {
      if (!api || !alive.current || !current.current) return false;
      setPending(true);
      try {
        const reply = await api.mutate({ expectedRevision: current.current.layout.revision, patch });
        if (!alive.current) return false;
        if (reply.ok) { adopt(reply.snapshot); setError(null); return true; }
        else { if ("snapshot" in reply && reply.snapshot) adopt(reply.snapshot); setError(reply.code); return false; }
      } catch { if (alive.current) setError("storage_error"); return false; }
      finally { if (alive.current) setPending(false); }
    });
    queue.current = result;
    return result;
  }, [api, adopt]);
  return { snapshot, error, pending, mutate };
}
