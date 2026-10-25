import { useEffect, useState } from "react";

function reducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Keeps something mounted for `exitMs` after it is turned off, so it can play an exit animation; `leaving` is true during
 * that time. Turning it back on while it is leaving cancels the exit. Reduced motion unmounts at once.
 */
export function usePresence(open: boolean, exitMs: number): { mounted: boolean; leaving: boolean } {
  const [mounted, setMounted] = useState(open);

  useEffect(() => {
    if (open) { setMounted(true); return; }
    if (!mounted) return;
    if (reducedMotion()) { setMounted(false); return; }
    const timer = setTimeout(() => setMounted(false), exitMs);
    return () => clearTimeout(timer);
  }, [open, mounted, exitMs]);

  return { mounted: open || mounted, leaving: !open && mounted };
}
