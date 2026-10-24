import { expect, it, vi, beforeEach, describe } from "vitest";
const mail = vi.hoisted(() => {
  const send = vi.fn();
  return { send, transport: vi.fn(() => ({ sendMail: send })), choose: vi.fn() };
});
vi.mock("nodemailer", () => ({ default: { createTransport: mail.transport } }));
vi.mock("../../chat/user-choice", () => ({ requestUserChoice: mail.choose }));
// 真实的工作区句柄 helper 按开发构建的位置查找；实时权限档位固定为 full，只看本次运行的快照档位。
vi.mock("electron", () => ({ app: { getPath: () => process.cwd(), isPackaged: false, getAppPath: () => process.cwd() } }));
vi.mock("../../permission/permission", async (importOriginal) => ({ ...await importOriginal<typeof import("../../permission/permission")>(), getCurrentLevel: () => "full" }));
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { setEmailConfig, registerEmailTools } from "./email-tools";
import { toolRegistry } from "./registry/tool-registry";

const message = { to: ["observer@example.org"], subject: "Observation report", body: "The night was clear." };
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "email-tools-"));
const workspace = path.join(sandbox, "workspace");
const report = path.join(workspace, "observations.docx");
const outside = path.join(sandbox, "private.txt");
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(report, "report bytes");
fs.writeFileSync(outside, "private bytes");
function configure(overrides: Partial<{ enabled: boolean; host: string; from: string }> = {}) {
  const settings = { enabled: true, host: "smtp.fixture.example", from: "Observatory", ...overrides };
  setEmailConfig(() => settings.enabled, () => settings.host, () => 587, () => false,
    () => "sender@example.org", () => "fixture-password-73", () => settings.from);
}
registerEmailTools();
const send = (args: Record<string, unknown> = message, context?: Parameters<NonNullable<ReturnType<typeof toolRegistry.getById>>["execute"]>[1]) =>
  toolRegistry.getById("send_email")!.execute(args, context);
beforeEach(() => {
  vi.clearAllMocks();
  mail.choose.mockReset().mockResolvedValue("send");
  mail.send.mockReset().mockResolvedValue({ messageId: "<fixture-73@example.org>" });
  configure();
});

describe("email validation and confirmation gates", () => {
  it.each([
    [{ enabled: false }, message, "[错误] 邮件功能未启用，请在设置里开启"],
    [{ host: "" }, message, "[错误] SMTP 配置不完整：缺少 主机/用户名/授权码"],
    [{}, { ...message, to: ["invalid-address-73"] }, "[错误] 收件人邮箱无效：invalid-address-73"],
  ] as const)("refuses an invalid configuration or recipient %j", async (settings, args, error) => {
    configure(settings);
    expect(await send(args)).toEqual(error);
    expect(mail.send).not.toHaveBeenCalled();
  });
  it("checks attachment existence before displaying a confirmation card", async () => {
    const missing = path.join(workspace, "missing.txt");
    expect(await send({ ...message, attachments: [missing] })).toBe(`[错误] 附件不存在：${missing}`);
    expect(mail.choose).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });
  it("refuses a relative attachment path", async () => {
    expect(await send({ ...message, attachments: ["observations.docx"] })).toBe("[错误] 附件必须是绝对路径：observations.docx");
    expect(mail.send).not.toHaveBeenCalled();
  });
  it("keeps a project-read-only run from attaching a file outside the workspace", async () => {
    const context = { userQuery: "", runId: "mail-run-73", fileAccessLevel: "project-read-only" as const, resolvedWorkspaceRoot: workspace };
    await expect(send({ ...message, attachments: [outside] }, context)).rejects.toMatchObject({ code: "E_WORKSPACE_BOUNDARY", reason: "outside-root" });
    expect(mail.choose).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
  });
  it("lets a restricted run attach a file inside the workspace and sends the bytes it read", async () => {
    const context = { userQuery: "", runId: "mail-run-73", fileAccessLevel: "project-read-only" as const, resolvedWorkspaceRoot: workspace };
    expect(await send({ ...message, attachments: [report] }, context)).toMatch(/^\[send_email\] 已发送/);
    expect(mail.send.mock.calls[0][0].attachments).toEqual([{ filename: "observations.docx", content: Buffer.from("report bytes") }]);
  });
  it("shows the full attachment path and size on the confirmation card", async () => {
    await send({ ...message, attachments: [report] });
    expect(mail.choose.mock.calls[0][0]).toContain(`  - ${report}（1 KB）`);
  });
  it("does not send when the user cancels", async () => {
    mail.choose.mockResolvedValue("cancel");
    expect(await send()).toEqual("[send_email] 用户取消发送");
    expect(mail.send).not.toHaveBeenCalled();
  });
  it("binds confirmation to the run and rejects a send answer after cancellation", async () => {
    const controller = new AbortController();
    mail.choose.mockImplementation(async () => { controller.abort(); return "send"; });
    await expect(send(message, { userQuery: "Send the report", runId: "mail-run-73", signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(mail.choose.mock.calls[0][3]).toEqual({ runId: "mail-run-73", signal: controller.signal });
    expect(mail.send).not.toHaveBeenCalled();
  });
  it("propagates cancellation while a confirmation card is pending", async () => {
    mail.choose.mockRejectedValue(Object.assign(new Error("Confirmation cancelled"), { name: "AbortError" }));
    await expect(send(message, { userQuery: "", runId: "mail-run-73" })).rejects.toMatchObject({ name: "AbortError" });
    expect(mail.send).not.toHaveBeenCalled();
  });
});

describe("confirmed SMTP messages", () => {
  it("maps transport settings, recipients and attachments without adding an empty CC", async () => {
    expect(await send({ ...message, to: ["observer@example.org", "reviewer@example.org"], attachments: [report] }))
      .toEqual("[send_email] 已发送：observer@example.org, reviewer@example.org 主题：Observation report");
    expect(mail.transport).toHaveBeenCalledWith({ host: "smtp.fixture.example", port: 587, secure: false, auth: { user: "sender@example.org", pass: "fixture-password-73" } });
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(mail.send.mock.calls[0][0]).toEqual({
      from: '"Observatory" <sender@example.org>', to: "observer@example.org, reviewer@example.org", cc: undefined,
      subject: "Observation report", text: "The night was clear.", html: undefined,
      attachments: [{ filename: "observations.docx", content: Buffer.from("report bytes") }],
    });
  });
  it("escapes quoted sender display names", async () => {
    configure({ from: 'Team "North"' });
    await send();
    expect(mail.send.mock.calls[0][0].from).toEqual('"Team \\"North\\"" <sender@example.org>');
  });
  it("joins nonempty CC recipients in their supplied order", async () => {
    await send({ ...message, cc: ["assistant@example.org", "archive@example.org"] });
    expect(mail.send.mock.calls[0][0].cc).toBe("assistant@example.org, archive@example.org");
  });
  it("returns a transport failure as an error message", async () => {
    mail.send.mockRejectedValue(new Error("SMTP connection interrupted"));
    expect(await send()).toEqual("[错误] 发送失败：SMTP connection interrupted");
  });
});
