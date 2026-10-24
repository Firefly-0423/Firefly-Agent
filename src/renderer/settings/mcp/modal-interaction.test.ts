// @vitest-environment jsdom
import { afterEach, test, expect } from "vitest";
import * as dialogs from "../shared/modal";
import { CUSTOM_ENDPOINT_GUIDE_BODY as guide } from "./panel";

afterEach(() => { window.dispatchEvent(new Event("beforeunload")); });
const node = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  expect(found, id).not.toBeNull();
  return found as T;
};

test("endpoint help opens an accessible rich dialog, renders its title/icon, and acknowledges to completion", async () => {
  const closed = dialogs.showHtmlModal({ htmlBody: guide, icon: '<svg data-testid="guide-icon"></svg>', title: "模型服务接入说明" });
  const overlay = node("ff-html-modal-overlay");
  expect(overlay.classList.contains("is-hidden")).toEqual(false);
  const dialog = overlay.querySelector(".ff-html-modal")!;
  expect([dialog.getAttribute("role"), dialog.getAttribute("aria-modal")]).toEqual(["dialog", "true"]);
  expect(node("ff-html-modal-title").textContent).toEqual("模型服务接入说明");
  expect(node("ff-html-modal-icon").querySelector("svg")).not.toBeNull();
  const acknowledge = node<HTMLButtonElement>("ff-html-modal-confirm");
  expect(acknowledge.textContent).toEqual("知道了");
  acknowledge.click();
  await expect(closed).resolves.toEqual(undefined);
  expect(overlay.classList.contains("is-hidden")).toEqual(true);
});

test("rendered endpoint guidance contains providers, compatibility, security, limitations and all FAQ topics", () => {
  void dialogs.showHtmlModal({ title: "Endpoint reference", htmlBody: guide });
  const body = node("ff-html-modal-body").innerHTML;
  const passages = [
    "官方云端模型", "OpenAI、Claude、Kimi、DeepSeek、MiniMax、智谱 GLM", "自定义端点", "OpenAI 或 Anthropic 兼容接口",
    "本地模型与自定义端点不在官方技术支持范围内", "系统不会扫描端口、探测模型或自动升级能力档位",
    "你的 API Key 仅存储在本地设备", "不会上传至流萤的服务器", "本地模型回复格式异常", "MiniMax 思考模式失效", "Claude 配置项比其他厂商少",
  ];
  for (const passage of passages) expect(body.includes(passage), passage).toBe(true);
});

test("the MCP command input receives focus and confirms the typed launch command", async () => {
  const answer = dialogs.showInputModal({ placeholder: "node path\\to\\server.js", message: "输入启动命令", title: "添加 MCP Server" });
  const overlay = node("ff-input-overlay");
  expect(overlay.classList.contains("is-hidden")).toEqual(false);
  expect(node("ff-input-title").textContent).toEqual("添加 MCP Server");
  const field = node<HTMLInputElement>("ff-input-field");
  expect(document.activeElement).toEqual(field);
  field.value = "node C:\\tools\\observatory.js --listen 9440";
  node("ff-input-confirm").click();
  await expect(answer).resolves.toEqual("node C:\\tools\\observatory.js --listen 9440");
  expect(overlay.classList.contains("is-hidden")).toEqual(true);
});

test.each(["Enter", "Escape", "Cancel"])("input dialog handles %s with the expected result", async action => {
  const pending = dialogs.showInputModal({ title: "MCP Server 名称", message: "给这个 MCP server 起个名字" });
  const input = node<HTMLInputElement>("ff-input-field");
  input.value = "云图服务";
  if (action === "Cancel") node("ff-input-cancel").click();
  else input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: action }));
  await expect(pending).resolves.toEqual(action === "Enter" ? "云图服务" : null);
});

test.each([true, false])("legacy confirmation resolves %s and uses semantic warning artwork", async approved => {
  const pending = dialogs.showModal({ title: approved ? "提示" : "添加失败", message: approved ? '"云图服务" 已连接，发现 5 个工具。详情见终端日志。' : "启动命令无效（详情见终端日志）" });
  const overlay = node("ff-modal-overlay");
  expect(overlay.classList.contains("is-hidden")).toEqual(false);
  expect(overlay.querySelector(".ff-modal")?.classList.contains("ff-modal--warning")).toBe(true);
  const icon = node("ff-modal-icon");
  expect(icon.querySelector("svg")).not.toBeNull();
  expect(icon.classList.contains("ff-modal__icon--warning")).toEqual(true);
  if (approved) expect(node("ff-modal-message").textContent).toContain("已连接，发现 5 个工具");
  node(approved ? "ff-modal-confirm" : "ff-modal-cancel").click();
  await expect(pending).resolves.toEqual(approved);
  expect(overlay.classList.contains("is-hidden")).toEqual(true);
});


test("rich help and semantic confirmation keep separate overlays while sharing completion order", async () => {
  const readHelp = dialogs.showHtmlModal({ title: "Connection reference", htmlBody: "<p>Review the available transports.</p>" });
  const choose = dialogs.showModal({ title: "Continue", message: "Apply these connection settings?" });
  const helpOverlay = node("ff-html-modal-overlay");
  expect([...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter(dialog => !dialog.closest(".is-hidden"))).toHaveLength(1);
  node("ff-html-modal-confirm").click();
  await expect(readHelp).resolves.toEqual(undefined);
  const semanticOverlay = node("ff-modal-overlay");
  expect(semanticOverlay).not.toBe(helpOverlay);
  expect(helpOverlay.classList.contains("is-hidden")).toBe(true);
  expect(semanticOverlay.classList.contains("is-hidden")).toBe(false);
  node("ff-modal-confirm").click();
  await expect(choose).resolves.toEqual(true);
});
