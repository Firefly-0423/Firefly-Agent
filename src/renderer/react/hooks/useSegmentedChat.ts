import { useEffect, useState } from "react";

function readSegmentedChat(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.segmentedChat !== undefined;
}

/** Whether Chat replies are shown as several bubbles. `ui/appearance-prefs.ts` owns the attribute; this only follows it. */
export function useSegmentedChat(): boolean {
  const [segmented, setSegmented] = useState(readSegmentedChat);
  useEffect(() => {
    const update = () => setSegmented(readSegmentedChat());
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-segmented-chat"] });
    return () => observer.disconnect();
  }, []);
  return segmented;
}
