import { toolRegistry, type ToolDefinition } from "../../orchestrator/tools/registry/tool-registry";
import { openKnowledgeWorkspace } from "../knowledge-workspace";
import { openNote } from "./obsidian-open";
import * as path from "path";

// Schemas and model-facing prose are immutable contracts, separate from execution.
function specifications(): Array<Omit<ToolDefinition, "execute">> { return [
  {
    "id": "obsidian_list_files",
    "name": "列出笔记文件",
    "description": "列出 Obsidian Vault 中的 Markdown 笔记文件。\n\n何时用：\n- 想浏览 Vault 中有什么笔记\n- 查找特定目录下的所有笔记\n- 确认某个笔记是否存在\n\n参数：relativeDir（可选，目录相对路径），recursive（可选，是否递归，默认 true）",
    "enabled": true,
    "modes": [
      "work"
    ],
    "needsContext": true,
    "effectKind": "read",
    "verificationPolicy": "none",
    "inputSchema": {
      "type": "object",
      "properties": {
        "relativeDir": {
          "type": "string",
          "description": "相对于 Vault 根目录的路径，如 'notes/'。不填则列出根目录。"
        },
        "recursive": {
          "type": "boolean",
          "description": "是否递归子目录，默认 true。"
        }
      },
      "required": []
    }
  },
  {
    "id": "obsidian_search",
    "name": "搜索笔记",
    "description": "在 Obsidian Vault 中搜索笔记：匹配文件名、标题和正文内容。\n\n何时用：\n- 用户问「笔记里有关于 xxx 的内容吗」\n- 不确定某个知识在哪篇笔记里\n- 需要找到特定主题相关所有笔记\n\n参数：query（必填，搜索关键词），relativeDir（可选，限制目录），limit（可选，默认 20）",
    "enabled": true,
    "modes": [
      "work"
    ],
    "needsContext": true,
    "effectKind": "read",
    "verificationPolicy": "none",
    "inputSchema": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "搜索关键词，支持中文和英文。"
        },
        "relativeDir": {
          "type": "string",
          "description": "限制搜索目录，如 'notes/'。不填搜索整个 Vault。"
        },
        "limit": {
          "type": "integer",
          "description": "最大返回条数，默认 20。"
        }
      },
      "required": [
        "query"
      ]
    }
  },
  {
    "id": "obsidian_read_file",
    "name": "阅读笔记全文",
    "description": "读取 Obsidian Vault 中某个 Markdown 笔记的完整内容，返回全文及文件标题列表。\n\n何时用：\n- 需要查看笔记的完整内容\n- 了解笔记的整体结构\n- 为后续的章节编辑操作获取 contentHash\n\n非必须时优先用 obsidian_read_section 精准读取章节，避免返回过长内容。",
    "enabled": true,
    "modes": [
      "work"
    ],
    "needsContext": true,
    "effectKind": "read",
    "verificationPolicy": "none",
    "inputSchema": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "笔记在 Vault 中的相对路径，如 'notes/Transformer 学习笔记.md'。"
        }
      },
      "required": [
        "path"
      ]
    }
  },
  {
    "id": "obsidian_read_section",
    "name": "阅读笔记章节",
    "description": "按标题路径精准读取 Obsidian 笔记中的某个章节内容。\n\n何时用：\n- 用户明确提到某个笔记的特定章节\n- 只需要某个知识点，不需要读整篇\n- 笔记很长但只需要部分内容\n\n参数：path（笔记路径），headingPath（标题路径数组，如 ['Transformer', 'Self-Attention', 'QKV']），includeChildren（可选，是否包含子章节，默认 false）",
    "enabled": true,
    "modes": [
      "work"
    ],
    "needsContext": true,
    "effectKind": "read",
    "verificationPolicy": "none",
    "inputSchema": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "笔记在 Vault 中的相对路径。"
        },
        "headingPath": {
          "type": "array",
          "description": "标题路径，从一级标题开始，如 ['第一章', '第二节', '知识点']。",
          "items": {
            "type": "string",
            "description": "标题路径中的一层"
          }
        },
        "includeChildren": {
          "type": "boolean",
          "description": "是否包含子章节内容。默认 false（只返回该标题的直属内容）。"
        }
      },
      "required": [
        "path",
        "headingPath"
      ]
    }
  },
  {
    "id": "obsidian_edit",
    "name": "编辑笔记",
    "description": "在 Obsidian Vault 中创建或修改笔记内容。支持以下操作：\n\n- create：创建新笔记（目标已存在时拒绝，永不覆盖已有文件）\n- replace_file：完整替换文件内容（必须先读，带 expectedContentHash）\n- append：在文件末尾追加内容（必须先读，带 expectedContentHash）\n- replace_section：替换某个标题章节下的内容（必须先读，带 expectedContentHash）\n- append_to_section：追加到某个标题章节末尾（必须先读，带 expectedContentHash）\n\n写契约（必须遵守）：\n1. create 永不覆盖：目标文件已存在时会被拒绝，此时应改为先读取再编辑。\n2. 修改已有文件必须携带 expectedContentHash：先用 obsidian_read_file 读取全文拿到 contentHash，再在本次编辑中提供。缺失会被直接拒绝；不匹配说明文件已被外部修改，必须重新读取。\n\n参数：operation（操作类型）、path（笔记路径）、content（内容）、expectedContentHash（修改已有文件时必填）、headingPath（replace_section/append_to_section 时需要）、includeChildren（replace_section 时）",
    "enabled": true,
    "modes": [
      "work"
    ],
    "needsContext": true,
    "effectKind": "mutation",
    "risk": "fs-write",
    "verificationPolicy": "artifact",
    "inputSchema": {
      "type": "object",
      "properties": {
        "operation": {
          "type": "string",
          "description": "操作类型：create | replace_file | append | replace_section | append_to_section",
          "enum": [
            "create",
            "replace_file",
            "append",
            "replace_section",
            "append_to_section"
          ]
        },
        "path": {
          "type": "string",
          "description": "笔记在 Vault 中的相对路径。"
        },
        "content": {
          "type": "string",
          "description": "要写入的 Markdown 内容。"
        },
        "headingPath": {
          "type": "array",
          "description": "目标章节的标题路径（仅 replace_section 和 append_to_section 需要）。",
          "items": {
            "type": "string",
            "description": "标题路径中的一层"
          }
        },
        "expectedContentHash": {
          "type": "string",
          "description": "通过 obsidian_read_file 获取的 contentHash。修改已有文件（replace_file / append / replace_section / append_to_section）时必填，缺失会被拒绝。create 操作不需要。"
        },
        "includeChildren": {
          "type": "boolean",
          "description": "replace_section 时是否同时替换子章节。默认 false。"
        }
      },
      "required": [
        "operation",
        "path",
        "content"
      ]
    }
  },
  {
    "id": "obsidian_open_note",
    "name": "打开笔记",
    "description": "通过 obsidian:// 协议在 Obsidian 应用中打开指定笔记。\n\n何时用：\n- 用户说「帮我打开 xxx 笔记」\n- 需要让用户在 Obsidian 中查看或编辑笔记\n- 教学完成后打开相关笔记供用户阅读\n\n参数：path（笔记路径）、headingPath（可选，定位到具体章节）",
    "enabled": true,
    "modes": [
      "work"
    ],
    "needsContext": true,
    "effectKind": "external_side_effect",
    "risk": "network",
    "verificationPolicy": "none",
    "inputSchema": {
      "type": "object",
      "properties": {
        "path": {
          "type": "string",
          "description": "笔记在 Vault 中的相对路径。"
        },
        "headingPath": {
          "type": "array",
          "description": "可选标题路径，打开笔记后滚动到指定章节。",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "path"
      ]
    }
  }
]; }

type Executor = ToolDefinition["execute"];
type Context = Parameters<Executor>[1];
function workspaceFor(context: Context) {
  const workspace = openKnowledgeWorkspace(context?.mode, context?.resolvedWorkspaceRoot);
  if (!workspace) throw new Error("KNOWLEDGE_WORKSPACE_REQUIRED");
  return workspace;
}
const stringOption = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
const headingsOption = (value: unknown): string[] | undefined => Array.isArray(value) ? value.map(String) : undefined;

const listNotes: Executor = async (args, context) => {
  const workspace = workspaceFor(context);
  const notes = await workspace.listFiles({ relativeDir: stringOption(args.relativeDir), recursive: args.recursive !== false });
  if (!notes.length) return "（未找到 Markdown 笔记文件）";
  return notes.map((note) => `- ${note.path} (${(note.size / 1024).toFixed(1)} KB, ${new Date(note.modifiedAt).toLocaleString("zh-CN")})`).join("\n");
};
const searchNotes: Executor = async (args, context) => {
  const workspace = workspaceFor(context);
  const matches = await workspace.search({ query: String(args.query), relativeDir: stringOption(args.relativeDir),
    limit: typeof args.limit === "number" ? args.limit : undefined });
  if (!matches.length) return `（未找到匹配 "${args.query}" 的笔记）`;
  return matches.map((match) => {
    const label = match.matchType === "filename" ? "文件名匹配"
      : match.matchType === "heading" ? `标题匹配: ${match.headingPath?.join(" > ") ?? match.matchText}` : "正文匹配";
    return `- ${match.path} [${label}]${match.matchText ? ` "${match.matchText}"` : ""}`;
  }).join("\n");
};
const readNote: Executor = async (args, context) => {
  const workspace = workspaceFor(context);
  const note = await workspace.readFile({ path: String(args.path) });
  const outline = note.headings.length > 0
    ? "\n\n---\n标题列表:\n" + note.headings.map((heading) => `${"  ".repeat(heading.depth - 1)}- ${heading.text}`).join("\n") : "";
  return note.content + outline + `\n\n---\ncontentHash: ${note.contentHash}`;
};
const readNoteSection: Executor = async (args, context) => {
  const workspace = workspaceFor(context);
  const section = await workspace.readSection({ path: String(args.path), headingPath: headingsOption(args.headingPath) ?? [],
    includeChildren: args.includeChildren === true });
  const label = section.headingPath.join(" > ");
  return `## ${label}\n\n${section.content}`;
};
const editNote: Executor = async (args, context) => {
  const workspace = workspaceFor(context);
  const operation = String(args.operation);
  const outcome = await workspace.edit({ operation, path: String(args.path), content: String(args.content ?? ""),
    headingPath: headingsOption(args.headingPath), expectedContentHash: stringOption(args.expectedContentHash),
    includeChildren: args.includeChildren === true ? true : undefined } as any);
  return `操作成功 [${outcome.operation}]\n` + `文件: ${outcome.path}\n`
    + `写入: ${outcome.bytesWritten} 字节\n` + `contentHash: ${outcome.newContentHash}`;
};
const openNoteInApp: Executor = async (args, context) => {
  workspaceFor(context);
  const vaultName = path.basename(context!.resolvedWorkspaceRoot!);
  await openNote({ vaultName, filePath: String(args.path), headingPath: headingsOption(args.headingPath) });
  // Preserve the original input's join semantics in the user-visible suffix.
  const suffix = Array.isArray(args.headingPath) && args.headingPath.length > 0 ? ` → ${args.headingPath.join(" > ")}` : "";
  return `已在 Obsidian 中打开: ${args.path}${suffix}`;
};
const executions: Record<string, Executor> = {
  obsidian_list_files: listNotes, obsidian_search: searchNotes, obsidian_read_file: readNote,
  obsidian_read_section: readNoteSection, obsidian_edit: editNote, obsidian_open_note: openNoteInApp,
};
export function registerObsidianTools(): void {
  for (const specification of specifications()) toolRegistry.register({ ...specification, execute: executions[specification.id] });
}
export function unregisterObsidianTools(): void {
  for (const id of Object.keys(executions)) toolRegistry.unregister(id);
}
