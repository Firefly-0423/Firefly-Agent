import * as fs from "fs";
import * as path from "path";
import nodemailer from "nodemailer";
import { toolRegistry } from "./registry/tool-registry";
import type { ToolContext } from "./registry/tool-context";
import { createAbortError } from "../../abort-utils";
import { requestUserChoice, type ChoiceOption } from "../../user-choice";
import { assertWorkspacePathFallback } from "./workspace-boundary";
import { readWorkspaceFile } from "./workspace-handle";
import { logger, LogTag } from "../../logger";

type EmailConfiguration = {
  enabled: (() => boolean) | null; host: (() => string) | null; port: (() => number) | null;
  secure: (() => boolean) | null; user: (() => string) | null; pass: (() => string) | null;
  fromName: (() => string) | null;
};
const configuration: EmailConfiguration = { enabled: null, host: null, port: null, secure: null, user: null, pass: null, fromName: null };
function readSetting<T>(reader: (() => T) | null): T | undefined { return reader?.(); }
export function setEmailConfig(
  enabledGetter: () => boolean, hostGetter: () => string, portGetter: () => number,
  secureGetter: () => boolean, userGetter: () => string, passGetter: () => string,
  fromNameFn: () => string,
): void {
  configuration.enabled = enabledGetter;
  configuration.host = hostGetter;
  configuration.port = portGetter;
  configuration.secure = secureGetter;
  configuration.user = userGetter;
  configuration.pass = passGetter;
  configuration.fromName = fromNameFn;
}
function addressList(value: unknown): string[] {
  return (value as unknown[] ?? []).map(String).map(item => item.trim()).filter(Boolean);
}
/** 单个附件和全部附件的大小上限（SMTP 服务通常不收超过 25 MB 的邮件）。 */
const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
const ATTACHMENTS_TOTAL_MAX_BYTES = 25 * 1024 * 1024;

type LoadedAttachment = { location: string; filename: string; content: Buffer };

/**
 * 按当前权限等级读取附件：受限等级经工作区边界读取，读出的字节直接交给邮件，发送时不再按路径重读。
 * 返回错误文本或读好的附件。
 */
async function loadAttachments(files: string[], ctx?: ToolContext): Promise<string | LoadedAttachment[]> {
  const loaded: LoadedAttachment[] = [];
  let total = 0;
  for (const supplied of files) {
    if (!path.isAbsolute(supplied)) return `[错误] 附件必须是绝对路径：${supplied}`;
    const location = path.resolve(supplied);
    const observed = await readWorkspaceFile(location, ctx, ATTACHMENT_MAX_BYTES);
    let content: Buffer;
    if (observed) {
      if (!observed.exists) return `[错误] 附件不存在：${location}`;
      if (observed.kind !== "file") return `[错误] 附件不是文件：${location}`;
      if (!observed.bytes) return `[错误] 附件超过 ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB：${location}`;
      content = observed.bytes;
    } else {
      assertWorkspacePathFallback(location, "read", ctx);
      let entry: fs.Stats;
      try { entry = fs.statSync(location); } catch { return `[错误] 附件不存在：${location}`; }
      if (!entry.isFile()) return `[错误] 附件不是文件：${location}`;
      if (entry.size > ATTACHMENT_MAX_BYTES) return `[错误] 附件超过 ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB：${location}`;
      content = fs.readFileSync(location);
    }
    total += content.length;
    if (total > ATTACHMENTS_TOTAL_MAX_BYTES) return `[错误] 附件合计超过 ${ATTACHMENTS_TOTAL_MAX_BYTES / 1024 / 1024} MB`;
    loaded.push({ location, filename: path.basename(location), content });
  }
  return loaded;
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function badAddress(addresses: string[]): string | undefined {
  return addresses.find(item => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item));
}
async function executeSendEmail(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  if (!(readSetting(configuration.enabled) ?? false)) return "[错误] 邮件功能未启用，请在设置里开启";
  const server = readSetting(configuration.host) ?? "";
  const account = readSetting(configuration.user) ?? "";
  const password = readSetting(configuration.pass) ?? "";
  if (!server || !account || !password) return "[错误] SMTP 配置不完整：缺少 主机/用户名/授权码";
  const serverPort = readSetting(configuration.port) ?? 465;
  const useTls = readSetting(configuration.secure) ?? (serverPort === 465);
  const senderName = readSetting(configuration.fromName) ?? "";
  const recipients = addressList(args.to);
  if (recipients.length === 0) return "[错误] 收件人列表为空";
  const invalidRecipient = badAddress(recipients);
  if (invalidRecipient) return `[错误] 收件人邮箱无效：${invalidRecipient}`;
  const copies = addressList(args.cc);
  const invalidCopy = badAddress(copies);
  if (invalidCopy) return `[错误] 抄送邮箱无效：${invalidCopy}`;
  const headline = String(args.subject ?? "").trim();
  const plain = String(args.body ?? "").trim();
  const markup = args.html ? String(args.html) : undefined;
  if (!headline) return "[错误] 邮件主题不能为空";
  if (!plain && !markup) return "[错误] 邮件正文不能为空";
  const attachments = await loadAttachments(addressList(args.attachments), ctx);
  if (typeof attachments === "string") return attachments;
  const preview = plain.length > 100 ? plain.slice(0, 100) + "…" : plain;
  // 确认卡列出完整路径和大小，用户能看清到底发出去的是哪个文件。
  const names = attachments.length > 0
    ? attachments.map(item => `
  - ${item.location}（${formatSize(item.content.length)}）`).join("")
    : "（无）";
  const confirmation = ["确认发送邮件？", `收件人：${recipients.join(", ")}`,
    copies.length > 0 ? `抄送：${copies.join(", ")}` : null,
    `主题：${headline}`, `正文摘要：${preview}`, `附件：${names}`].filter(Boolean).join("\n");
  const buttons: ChoiceOption[] = [{ label: "发送", value: "send" }, { label: "取消", value: "cancel" }];
  const answer = await requestUserChoice(confirmation, buttons, "cancel", { runId: ctx?.runId, signal: ctx?.signal });
  if (ctx?.signal?.aborted) throw createAbortError();
  if (answer !== "send") return "[send_email] 用户取消发送";
  try {
    const connection = nodemailer.createTransport({ host: server, port: serverPort, secure: useTls, auth: { user: account, pass: password } });
    const escaped = senderName.replace(/"/g, '\\"');
    const sender = senderName ? `"${escaped}" <${account}>` : account;
    const copyHeader = copies.length > 0 ? copies.join(", ") : undefined;
    const receipt = await connection.sendMail({
      from: sender, to: recipients.join(", "), cc: copyHeader, subject: headline, text: plain, html: markup,
      attachments: attachments.map(item => ({ filename: item.filename, content: item.content })),
    });
    console.log("[EmailTools]", "已发送：", receipt.messageId);
    return `[send_email] 已发送：${recipients.join(", ")} 主题：${headline}`;
  } catch (failure) {
    const detail = failure instanceof Error ? failure.message : String(failure);
    console.error("[EmailTools]", "发送失败：", detail);
    return `[错误] 发送失败：${detail}`;
  }
}
export function registerEmailTools(): void {
  const HANDLER_send_email = executeSendEmail;
  toolRegistry.register({
  "id": "send_email",
  "name": "发送邮件",
  "description": "通过 SMTP 发送邮件给指定收件人，支持附件、抄送。\n\n何时用：\n- 用户要求发邮件给某人（如「把这份报告发给 xxx@xxx.com」）\n- 配合 write_word/excel/pdf 工具，把生成的文件作为附件发送\n- 发送正式邮件、周报、通知等\n\n不要用于：\n- 群发营销邮件（每次只能发少量收件人）\n- 不带任何正文内容的空邮件\n- 未在设置里配置 SMTP 的情况（会返回配置缺失错误提示）\n\n参数：to（收件人数组）、subject（主题）、body（纯文本正文）、html（可选 HTML 正文，提供则覆盖 body）、cc（可选抄送）、attachments（可选附件绝对路径数组）。",
  "enabled": true,
  "risk": "network",
  "modes": [
    "work"
  ],
  "effectKind": "external_side_effect",
  "inputSchema": {
    "type": "object",
    "properties": {
      "to": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "description": "收件人邮箱地址数组"
      },
      "cc": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "description": "抄送（可选）"
      },
      "subject": {
        "type": "string",
        "description": "邮件主题"
      },
      "body": {
        "type": "string",
        "description": "邮件正文（纯文本）"
      },
      "html": {
        "type": "string",
        "description": "HTML 正文（可选，提供则覆盖 body）"
      },
      "attachments": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "description": "附件绝对路径数组（agent 生成文件或本地文件路径）"
      }
    },
    "required": [
      "to",
      "subject",
      "body"
    ]
  }
, execute: HANDLER_send_email });
  logger.info(LogTag.EmailTools, "registered: send_email");
}
