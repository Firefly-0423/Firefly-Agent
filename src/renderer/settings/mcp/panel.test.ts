// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, afterEach, test, expect, vi } from "vitest";

const feedback = vi.hoisted(() => ({ input: vi.fn(), confirm: vi.fn(), alert: vi.fn(), notice: vi.fn(), html: vi.fn() }));
vi.mock("../shared/modal", () => ({ showInputModal: feedback.input, showConfirm: feedback.confirm, showAlert: feedback.alert, showNotice: feedback.notice, showHtmlModal: feedback.html }));
const asset = (file: string) => readFileSync(resolve(__dirname, file), "utf8");

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  document.body.innerHTML = asset("../index.html");
  feedback.input.mockReset();
  feedback.confirm.mockResolvedValue(true);
  Object.assign(window, { settings: { listMcpServers: vi.fn(async () => []), addMcpServer: vi.fn(async () => ({ ok: true, toolIds: ["forecast", "radar", "alerts", "history", "locations"] })) } });
});
afterEach(() => { window.dispatchEvent(new Event("pagehide")); document.body.replaceChildren(); });

async function mount() {
  const panel = await import("./panel");
  await Promise.resolve();
  return panel;
}
const addButton = () => document.querySelector<HTMLButtonElement>("#mcp-panel .mcp-add-btn")!;

test("MCP owns its navigation, heading Add action and server host, while endpoint controls stay available", async () => {
  await mount();
  expect(document.querySelector('[aria-controls="mcp-panel"][data-section="mcp"]')).not.toBeNull();
  const panel = document.querySelector('#mcp-panel[data-panel="mcp"]')!;
  const heading = panel.querySelector(".plugin-panel-heading")!;
  expect(heading.querySelector(".btn-secondary.mcp-add-btn")).not.toBeNull();
  expect(panel.querySelector(".mcp-server-host")).not.toBeNull();
  expect(heading.compareDocumentPosition(panel.querySelector(".mcp-server-host")!) & 4).toBe(4);
  expect(document.querySelector(".plugin-add-btn")).toBeNull();
  expect(document.getElementById("custom-endpoint-controls")).not.toBeNull();
  expect(document.getElementById("custom-endpoint-guide-btn")).not.toBeNull();
});

test("Add collects command then name, uses stdio IPC, and reports the resulting tool count", async () => {
  feedback.input.mockResolvedValueOnce("node observatory.js --listen 9440").mockResolvedValueOnce("云图服务");
  await mount();
  addButton().click();
  await vi.waitFor(() => expect(feedback.notice).toHaveBeenCalledTimes(1));
  const prompts = feedback.input.mock.calls.map(([options]) => [options.title, options.message]);
  expect(prompts).toEqual([["添加 MCP Server", expect.stringContaining("输入启动命令")], ["MCP Server 名称", expect.stringContaining("给这个 MCP server 起个名字")]]);
  expect(window.settings!.addMcpServer).toHaveBeenCalledWith(expect.objectContaining({ name: "云图服务", transport: "stdio", command: "node", args: ["observatory.js", "--listen", "9440"] }));
  expect(feedback.notice.mock.calls[0][0]).toMatchObject({ tone: "success" });
  expect(feedback.notice.mock.calls[0][0].message).toContain("已连接，发现");
  expect(feedback.notice.mock.calls[0][0].message).toContain("5 个工具");
});

test.each([null, "   "])("a canceled or blank command %s never reaches IPC", async command => {
  feedback.input.mockResolvedValueOnce(command);
  await mount();
  addButton().click();
  await vi.waitFor(() => expect(addButton().disabled).toBe(false));
  expect(feedback.input).toHaveBeenCalledTimes(1);
  expect(window.settings!.addMcpServer).not.toHaveBeenCalled();
});

test("an unsuccessful add displays a shared failure dialog", async () => {
  feedback.input.mockResolvedValueOnce("node broken.js").mockResolvedValueOnce("Unavailable service");
  vi.mocked(window.settings!.addMcpServer!).mockResolvedValue({ ok: false, error: "backend rejected" } as never);
  await mount();
  addButton().click();
  await vi.waitFor(() => expect(feedback.alert).toHaveBeenCalled());
  expect(feedback.alert.mock.calls[0][0].title).toContain("添加失败");
});

test("the guide trigger supplies the complete provider, safety and compatibility explanation", async () => {
  const panel = await mount();
  document.getElementById("custom-endpoint-guide-btn")!.click();
  expect(feedback.html).toHaveBeenCalledTimes(1);
  const options = feedback.html.mock.calls[0][0];
  expect(options.title).toEqual("模型服务接入说明");
  expect(options.htmlBody).toEqual(panel.CUSTOM_ENDPOINT_GUIDE_BODY);
  const guide = document.createElement("div");
  guide.innerHTML = options.htmlBody;
  for (const text of ["官方云端模型", "OpenAI、Claude、Kimi、DeepSeek、MiniMax、智谱 GLM、通义千问、小米 MiMo、OpenRouter", "自定义端点", "高级", "OpenAI 或 Anthropic 兼容接口", "本地模型与自定义端点不在官方技术支持范围内", "系统不会扫描端口、探测模型或自动升级能力档位", "你的 API Key 仅存储在本地设备，不会上传至流萤的服务器", "测试连接", "连接成功仅表示服务能够响应"]) expect(guide.textContent).toContain(text);
  expect([...guide.querySelectorAll("details > summary")].map(item => item.textContent)).toEqual(["本地模型回复格式异常", "MiniMax 思考模式失效", "Claude 配置项比其他厂商少"]);
});
