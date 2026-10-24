import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** How long the docked sidebar takes to slide out of or back into the row; matches the CSS transition. */
export const SIDEBAR_FOLD_MS = 240;

export type SidebarFoldPhase = "docked" | "closing" | "opening" | "floating";

function reducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Folding the sidebar turns it into a floating overlay, which takes it out of the row at once, so the conversation used
 * to jump sideways in a single frame. This keeps it docked a moment longer while it slides out ("closing"), and on the way
 * back docks it folded first ("opening") so the next frame can slide it in. Reduced motion skips straight to the end state.
 */
export function useSidebarFold(collapsed: boolean): SidebarFoldPhase {
  const [phase, setPhase] = useState<SidebarFoldPhase>(collapsed ? "floating" : "docked");
  const first = useRef(true);

  useLayoutEffect(() => {
    if (first.current) { first.current = false; return; }
    if (reducedMotion()) { setPhase(collapsed ? "floating" : "docked"); return; }
    setPhase(collapsed ? "closing" : "opening");
  }, [collapsed]);

  useEffect(() => {
    if (phase === "closing") {
      const timer = setTimeout(() => setPhase("floating"), SIDEBAR_FOLD_MS);
      return () => clearTimeout(timer);
    }
    if (phase === "opening") {
      // Two frames: the folded layout has to be painted once before the transition back to zero can run.
      let second = 0;
      const firstFrame = requestAnimationFrame(() => { second = requestAnimationFrame(() => setPhase("docked")); });
      return () => { cancelAnimationFrame(firstFrame); cancelAnimationFrame(second); };
    }
  }, [phase]);

  return phase;
}
