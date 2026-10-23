import { expect, it, vi, beforeEach, describe } from "vitest";
const mail = vi.hoisted(() => {
  const send = vi.fn();
  return { send, transport: vi.fn(() => ({ sendMail: send })), choose: vi.fn(), exists: vi.fn() };
});
vi.mock("nodemailer", () => ({ default: { createTransport: mail.transport } }));
vi.mock("../../user-choice", () => ({ requestUserChoice: mail.choose }));
vi.mock("fs", async original => ({ ...await original<typeof import("fs")>(), existsSync: mail.exists }));
import { setEmailConfig, registerEmailTools } from "./email-tools";
import { toolRegistry } from "./registry/tool-registry";

const message = { to: ["observer@example.org"], subject: "Observation report", body: "The night was clear." };
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
  mail.exists.mockReturnValue(true);
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
    mail.exists.mockReturnValue(false);
    expect(await send({ ...message, attachments: ["E:/missing/observations.txt"] })).toBe("[错误] 附件不存在：E:/missing/observations.txt");
    expect(mail.choose).not.toHaveBeenCalled();
    expect(mail.send).not.toHaveBeenCalled();
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
    expect(await send({ ...message, to: ["observer@example.org", "reviewer@example.org"], attachments: ["E:/reports/observations.docx"] }))
      .toEqual("[send_email] 已发送：observer@example.org, reviewer@example.org 主题：Observation report");
    expect(mail.transport).toHaveBeenCalledWith({ host: "smtp.fixture.example", port: 587, secure: false, auth: { user: "sender@example.org", pass: "fixture-password-73" } });
    expect(mail.send).toHaveBeenCalledTimes(1);
    expect(mail.send.mock.calls[0][0]).toEqual({
      from: '"Observatory" <sender@example.org>', to: "observer@example.org, reviewer@example.org", cc: undefined,
      subject: "Observation report", text: "The night was clear.", html: undefined,
      attachments: [{ filename: "observations.docx", path: "E:/reports/observations.docx" }],
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
