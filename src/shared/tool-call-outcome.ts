/** 一次工具调用的结果分类；会话记录、运行循环和界面共用。 */
export type ToolCallOutcome = "not_executed" | "unknown" | "failure" | "success";
