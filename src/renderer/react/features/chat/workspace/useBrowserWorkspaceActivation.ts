import { useEffect, useRef } from "react";
import type { BrowserPageDto } from "../../../../../shared/manual-browser";

/** Presentation activation follows a new Main browser identity, never a navigation completion. */
export function useBrowserWorkspaceActivation(sessionId: string | undefined, onActivate: () => void) {
  const activate = useRef(onActivate); activate.current = onActivate;
  useEffect(() => {
    const api = window.manualBrowser;
    if (!sessionId || !api?.onChanged || !api.execute) return;
    let disposed = false, receivedEvent = false;
    const seen = new Set<string>();
    const accept = (page: BrowserPageDto) => {
      if (disposed || page.conversationId !== sessionId || seen.has(page.browserId)) return;
      seen.add(page.browserId);
      if (!page.closed) activate.current();
    };
    const off = api.onChanged(page => {
      if (page.conversationId !== sessionId || disposed) return;
      receivedEvent = true; accept(page);
    });
    void api.execute({ kind: "get" }).then(reply => {
      if (!receivedEvent && reply.ok && reply.value) accept(reply.value);
    }).catch(() => {});
    return () => { disposed = true; off(); };
  }, [sessionId]);
}
