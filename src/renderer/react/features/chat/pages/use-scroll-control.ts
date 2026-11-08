import { useCallback, useRef, useState } from "react";

export function useScrollControl() {
  const [visible, setVisible] = useState(false);
  const current = useRef<() => void>(() => {});
  const register = useCallback((action: () => void) => { current.current = action; }, []);
  const scroll = useCallback(() => current.current(), []);
  return { visible, setVisible, register, scroll };
}
