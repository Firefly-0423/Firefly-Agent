import { createContext, useContext } from "react";

/** Actions the message list can ask of the right-hand inspector without prop drilling through every row. */
export interface ChatInspectorActions {
  /** Opens the run result that holds this delegated task and scrolls to it. */
  openDelegation?: (taskId: string) => void;
}

export const ChatInspectorActionsContext = createContext<ChatInspectorActions>({});

export function useChatInspectorActions(): ChatInspectorActions {
  return useContext(ChatInspectorActionsContext);
}
