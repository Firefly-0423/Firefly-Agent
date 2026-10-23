import type { ChatMessage, ChatSession } from "../../shared/chat-types";

export function createWorkMarkdownSnapshot(session: ChatSession): string | null {
  if (session.mode !== "work") return null;
  const answer = [...session.messages].reverse().find((message): message is ChatMessage => message.role === "model");
  if (!answer || answer.runSnapshot?.status !== "terminal" || session.messages.at(-1)?.id !== answer.id) return null;

  const lines = [
    "# Work 任务记录",
    "",
    `任务状态：${answer.runSnapshot?.terminalStatus ?? "未确认"}`,
    "",
    "## 步骤状态",
    "",
  ];
  const todos = answer.runSnapshot?.todos ?? [];
  if (todos.length === 0) lines.push("未记录步骤。\n");
  else todos.forEach((todo, index) => lines.push(`${index + 1}. ${todo.status}`));
  lines.push("", "## 最终回答", "", answer.content || "（无最终回答）", "", "## 错误与文件读取", "");
  if (answer.runSnapshot?.terminalStatus !== "success") {
    lines.push(`运行未成功结束：${answer.runSnapshot?.terminalStatus ?? "未知"}。`);
  } else {
    lines.push("运行已结束。");
  }
  if (answer.workReadReport) {
    lines.push(`文件读取状态：${answer.workReadReport.status}。`);
    for (const file of answer.workReadReport.files) {
      lines.push(`- ${file.name}：${file.status}，${file.coveredLines}/${file.requiredLines} 行（全文 ${file.totalLines} 行）。`);
    }
  } else {
    lines.push("文件完整读取：未建立本次 Main 读取证据。");
  }
  lines.push("");
  return lines.join("\n");
}
