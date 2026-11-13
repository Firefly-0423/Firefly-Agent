import { createContext } from "react";

// Shared by ChatMessageList (provider) and StreamdownMessageContent (consumer).
// Kept in its own module so the two components do not import each other.
export const MessageStreamingContext = createContext(false);
export interface FileLinkEnv { workspaceRoot?: string; openFile?: (relPath: string, line?: number) => void; }
export const FileLinkContext = createContext<FileLinkEnv>({});
