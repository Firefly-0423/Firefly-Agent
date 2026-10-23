import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { usePanelRef, type GroupImperativeHandle, type PanelImperativeHandle } from "react-resizable-panels";

export function useInspectorPanelVisibility(visible: boolean, groupRef?: RefObject<GroupImperativeHandle | null>, registrationKey?: string) {
  const panelRef = usePanelRef();
  const [registeredPanel, setRegisteredPanel] = useState<PanelImperativeHandle | null>(null);
  const pending = useRef(true);
  const [registrationVersion, setRegistrationVersion] = useState(0);
  const onLayoutChange = useCallback((layout: Record<string, number>) => {
    if (!Object.hasOwn(layout, "inspector")) {
      pending.current = true; setRegisteredPanel(null); return;
    }
    setRegisteredPanel(panelRef.current);
    // Retry only unfinished registration; ordinary resize events must not reopen
    // an inspector the user collapsed with the separator.
    if (pending.current) setRegistrationVersion(version => version + 1);
  }, [panelRef]);
  useEffect(() => {
    pending.current = true;
    if (!registeredPanel || registeredPanel !== panelRef.current) return;
    const layout = groupRef?.current?.getLayout();
    if (groupRef && (!layout || !Object.hasOwn(layout, "inspector"))) return;
    if (visible) registeredPanel.expand(); else registeredPanel.collapse();
    pending.current = false;
  }, [visible, registeredPanel, panelRef, groupRef, registrationKey, registrationVersion]);
  return { panelRef, onLayoutChange };
}
