/** Legacy personal-memory tools. When the default memory runtime is on they are never offered to the model or shown in the tool list. */
export const RETIRED_MEMORY_TOOL_IDS: ReadonlySet<string> = new Set(["user_memory", "read_memory", "write_memory", "recall_history"]);
