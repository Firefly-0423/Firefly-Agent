import { useCallback, type RefObject } from "react";

type NavigationTarget = {
  openProject(path: string): void;
  handleRenameSession(id: string, title: string): Promise<void> | void;
  handleDeleteSession(id: string): Promise<void> | void;
  handleTogglePinSession(id: string, pinned: boolean): Promise<void> | void;
};

/** Navigation stays memoized while forwarding to the latest render's actions. */
export function useNavigationForwarders(target: RefObject<NavigationTarget>) {
  const openProject = useCallback((path: string) => target.current.openProject(path), [target]);
  const rename = useCallback((id: string, title: string) => { void target.current.handleRenameSession(id, title); }, [target]);
  const remove = useCallback((id: string) => { void target.current.handleDeleteSession(id); }, [target]);
  const pin = useCallback((id: string, pinned: boolean) => { void target.current.handleTogglePinSession(id, pinned); }, [target]);
  return { openProject, rename, remove, pin };
}
