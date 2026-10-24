import type { ToolContext } from "../registry/tool-context";
import type { ToolDefinition } from "../registry/tool-registry";
import { addMcpServer } from "../../mcp-manager";
import { createAbortError } from "../../../abort-utils";
import { classifyMcpFailure, MCP_FAILURE_REASONS } from "../../mcp-failure";
import { requestUserChoice, type ChoiceOption } from "../../../user-choice";

const LOG_PREFIX = "[BuiltinTools]";

async function executeInstallMcp(input: Record<string, unknown>, context?: ToolContext): Promise<string> {
  const identity = String(input.id || "").trim() || ("mcp-" + Date.now());
  const label = String(input.name || "").trim() || identity;
  const executable = String(input.command || "").trim();
  if (!executable) return "[错误] command 不能为空";
  const argv = Array.isArray(input.args) ? (input.args as unknown[]).map(value => String(value)) : [];
  let environment: Record<string, string> | undefined;
  if (input.env && typeof input.env === "object") {
    environment = {};
    for (const entry of Object.entries(input.env as Record<string, unknown>)) environment[entry[0]] = String(entry[1]);
  }
  const directory = input.cwd ? String(input.cwd) : undefined;
  const confirmation = [
    `确认安装并连接 MCP 服务「${label}」？`, `程序：${executable}`,
    `参数：${JSON.stringify(argv)}`, `工作目录：${directory ?? "默认"}`,
    `环境变量名称：${environment ? JSON.stringify(Object.keys(environment)) : "[]"}`,
    "它会被保存下来，之后启动流萤时自动连接。",
  ].join("\n");
  const choices: ChoiceOption[] = [{ label: "安装并连接", value: "install" }, { label: "取消", value: "cancel" }];
  const answer = await requestUserChoice(confirmation, choices, "cancel", { runId: context?.runId, signal: context?.signal });
  if (context?.signal?.aborted) throw createAbortError();
  if (answer !== "install") return "[install_mcp_server] 用户取消安装";
  console.log(LOG_PREFIX, "install_mcp_server:", identity);
  try {
    const connection = await addMcpServer({ id: identity, name: label, transport: "stdio", command: executable, args: argv, env: environment, cwd: directory });
    if (!connection.ok) {
      const reason = connection.reason && MCP_FAILURE_REASONS.includes(connection.reason) ? connection.reason : "failed";
      return "[错误] 安装失败: " + reason;
    }
    const available = connection.toolIds || [];
    return "✅ MCP server \"" + label + "\" 已连接\n" +
      "id: " + identity + "\n" +
      "command: " + executable + (argv.length ? " " + argv.join(" ") : "") + "\n" +
      "发现 " + available.length + " 个工具" + (available.length ? "：\n  - " + available.join("\n  - ") : "") + "\n" +
      "你现在可以让我用这些工具帮你做事。";
  } catch (failure) {
    return "[错误] 安装异常: " + classifyMcpFailure(failure);
  }
}

export const installMcpServerTool: ToolDefinition = {
  "id": "install_mcp_server",
  "name": "安装 MCP",
  "description": "把一个 MCP server 加到流萤的工具盘里：写入配置 → 启动 → 发现工具。\n\n何时用：\n- 用户明确要装某个 MCP server（'帮我装 xxx mcp'）\n- 用户给了 MCP 的 GitHub 仓库或配置\n\n推荐流程：先用 fetch_url 读 README，找到 mcpServers 配置块（command/args/env），再用本工具一次性安装。\n\n不要用于：\n- 日常工具调用（已注册的工具直接用）\n- 系统软件安装（那是 run_shell 的活）\n\n参数：id (可选，唯一标识，留空则用时间戳)，name (展示名)，command (可执行命令)，args (字符串数组)，env (键值对，环境变量)，cwd (可选工作目录)。",
  "enabled": true,
  "risk": "fs-write",
  "modes": [
    "code",
    "work"
  ],
  "effectKind": "mutation",
  "verificationPolicy": "artifact",
  "inputSchema": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "description": "唯一标识，留空则自动生成"
      },
      "name": {
        "type": "string",
        "description": "展示名，比如 'mail-mcp'"
      },
      "command": {
        "type": "string",
        "description": "可执行命令，例如 'node' / 'pythonw' / 'npx'"
      },
      "args": {
        "type": "array",
        "description": "命令行参数数组，例如 ['C:/.../bridging_mail_mcp.py']"
      },
      "env": {
        "type": "object",
        "description": "环境变量键值对"
      },
      "cwd": {
        "type": "string",
        "description": "工作目录绝对路径，可选"
      }
    },
    "required": [
      "command"
    ]
  },
  execute: executeInstallMcp,
};
