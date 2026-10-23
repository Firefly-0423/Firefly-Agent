// 前进 / 后退：记住"看过哪里"（某个会话，或某个全屏面板），像浏览器那样在这些位置之间来回走。
// - 只记有意义的位置：会话或面板；还没建出来的新任务不记。
// - 走到某处（go）是异步的，中间会经过半途状态；在走到目标之前不记录，避免把半途状态当成新的一步，超时也会放开。
// - 已被删除的会话（isAvailable 为 false）会被跳过。
// - 鼠标侧键（第 4 / 5 键）也能后退 / 前进。
import { useCallback, useEffect, useRef, useState } from "react";

export interface NavLocation {
  mode: string;
  sessionId?: string;
  /** 打开的全屏面板；null 表示在会话页。 */
  panel: string | null;
}

/** 历史最多保留这么多步。 */
export const NAVIGATION_HISTORY_LIMIT = 50;
/** 走到目标最多等这么久，之后恢复记录（目标没能打开时不至于一直不记）。 */
const SETTLE_MS = 2000;

const same = (left: NavLocation, right: NavLocation) =>
  left.mode === right.mode && left.sessionId === right.sessionId && left.panel === right.panel;
const worthKeeping = (location: NavLocation) => location.panel !== null || Boolean(location.sessionId);

interface History { entries: NavLocation[]; index: number }

export function useNavigationHistory({ current, go, isAvailable }: {
  current: NavLocation;
  go(location: NavLocation): void;
  isAvailable(location: NavLocation): boolean;
}) {
  const [history, setHistory] = useState<History>({ entries: [], index: -1 });
  const historyRef = useRef(history);
  historyRef.current = history;
  const arriving = useRef<NavLocation | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef({ go, isAvailable });
  latest.current = { go, isAvailable };

  const { mode, sessionId, panel } = current;
  useEffect(() => {
    const here: NavLocation = { mode, sessionId, panel };
    if (arriving.current) {
      if (same(here, arriving.current)) {
        arriving.current = null;
        clearTimeout(settleTimer.current);
      }
      return;
    }
    if (!worthKeeping(here)) return;
    setHistory(previous => {
      const at = previous.entries[previous.index];
      if (at && same(at, here)) return previous;
      const entries = [...previous.entries.slice(0, previous.index + 1), here].slice(-NAVIGATION_HISTORY_LIMIT);
      return { entries, index: entries.length - 1 };
    });
  }, [mode, sessionId, panel]);

  useEffect(() => () => clearTimeout(settleTimer.current), []);

  const find = (direction: -1 | 1): number => {
    const { entries, index } = historyRef.current;
    for (let at = index + direction; at >= 0 && at < entries.length; at += direction) {
      if (latest.current.isAvailable(entries[at]!)) return at;
    }
    return -1;
  };
  const canBack = find(-1) >= 0;
  const canForward = find(1) >= 0;

  const move = useCallback((direction: -1 | 1) => {
    const at = find(direction);
    if (at < 0) return;
    const target = historyRef.current.entries[at]!;
    arriving.current = target;
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => { arriving.current = null; }, SETTLE_MS);
    setHistory(previous => ({ ...previous, index: at }));
    latest.current.go(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const back = useCallback(() => move(-1), [move]);
  const forward = useCallback(() => move(1), [move]);

  useEffect(() => {
    const onMouseUp = (event: MouseEvent) => {
      if (event.button === 3) { event.preventDefault(); back(); }
      else if (event.button === 4) { event.preventDefault(); forward(); }
    };
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, [back, forward]);

  return { canBack, canForward, back, forward };
}
