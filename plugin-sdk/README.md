# @firefly_wu/plugin-sdk

Firefly 1.2.0 插件开发工具包。提供公开契约类型、`definePlugin`、`PluginError`、内存测试宿主 `createTestHost()` 与 `firefly-plugin` CLI（`validate` / `pack`）。

> **重要提示**：Firefly 1.2.0 插件系统不兼容 0.x 插件、旧版 `manifest.json`（`apiVersion: 1`）与旧版接口，宿主也不迁移 0.x 插件数据。详见下文「[与 0.x 的不兼容说明](#与-0x-的不兼容说明)」。

---

## 目录

- [安装](#安装)
- [最小插件示例](#最小插件示例)
- [权限一览与首次调用确认](#权限一览与首次调用确认)
- [工具的四种返回结果（ToolResult）](#工具的四种返回结果toolresult)
- [使用 createTestHost() 测试](#使用-createtestHost-测试)
- [CLI 校验与打包（firefly-plugin）](#cli-校验与打包firefly-plugin)
- [导出入口](#导出入口)
- [与 0.x 的不兼容说明](#与-0x-的不兼容说明)
- [信任边界](#信任边界)
- [English Summary](#english-summary)

---

## 安装

```bash
npm install @firefly_wu/plugin-sdk
```

从 Firefly 仓库源码本地构建并打包 SDK：

```bash
pnpm run build:plugin-sdk
npm pack ./plugin-sdk
```

---

## 最小插件示例

一个可校验、可打包的最小插件只需两个文件：清单 `firefly.plugin.json` 与入口脚本（`.mjs` 或 `.cjs`）。

### 1. 清单 `firefly.plugin.json`

<!-- doc-example: manifest id=readme-minimal -->
```json
{
  "schemaVersion": 1,
  "id": "dev.firefly.hello",
  "name": "Hello 示例插件",
  "version": "1.0.0",
  "sdk": "^1.2.0",
  "description": "演示 Firefly 1.2.0 最小工具注册与四态返回。",
  "author": {
    "name": "Firefly-0423"
  },
  "license": "MIT",
  "main": "index.mjs",
  "native": false,
  "permissions": [],
  "tools": [
    {
      "name": "greet",
      "title": "打招呼",
      "risk": ["fs-read"],
      "modes": ["work", "code"]
    }
  ]
}
```

- `id` 必须为 6–64 字符的反向域名（`^[a-z0-9]+(\.[a-z0-9-]+){2,}$`）。
- 每个声明在 `tools` 里的工具都必须列出真实 `risk`（**禁止使用 `"safe"`**）与可用 `modes`（`"work"` / `"code"`，Chat 模式不挂载插件工具）。
- 运行时注册的工具名、`context` id、`ui.windows` id 必须与清单一致，否则返回 `ERR_UNDECLARED`。

### 2. 入口 `index.mjs`

<!-- doc-example: plugin id=readme-minimal -->
```js
// 无需 import SDK：definePlugin 只是原样返回参数的类型辅助，直接默认导出对象即可。
// 宿主用原生 import() 加载入口，不会替插件解析 @firefly_wu/plugin-sdk。
const disposables = [];

/** @type {import("@firefly_wu/plugin-sdk").PluginDefinition} */
const plugin = {
  activate(ctx) {
    const tool = ctx.tools.register({
      name: "greet",
      description: "向指定对象打招呼。",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "称呼对象", minLength: 1 },
        },
        required: ["target"],
        additionalProperties: false,
      },
      describeApproval(args) {
        const target = typeof args?.target === "string" ? args.target.trim() : "";
        return {
          summary: target ? `向「${target}」发送问候` : "发送问候",
          target: target || undefined,
        };
      },
      async execute(args, call) {
        if (call.signal.aborted) {
          return { status: "not_executed", reason: "调用在执行前已取消" };
        }
        const target = typeof args?.target === "string" ? args.target.trim() : "";
        if (!target) {
          return { status: "not_executed", reason: "缺少有效的 target 参数" };
        }
        call.progress("正在生成问候语", 100);
        return {
          status: "succeeded",
          output: { greeting: `你好，${target}！`, mode: call.mode },
          summary: `已向 ${target} 打招呼`,
        };
      },
    });
    disposables.push(tool);
  },

  deactivate() {
    while (disposables.length > 0) {
      disposables.pop()?.dispose();
    }
  },
};

export default plugin;
```

> **入口里需要 SDK 运行时值时必须先打包。** `firefly-plugin pack` 只归档包目录内的文件，不会带上 `node_modules`，宿主也不会注入 SDK；入口中保留 `import { definePlugin, PluginError } from "@firefly_wu/plugin-sdk"` 这类运行时导入会在加载时抛出 `ERR_MODULE_NOT_FOUND`（`import type` 在编译后会被擦除，不受影响）。需要 `PluginError` 等运行时值或使用 TypeScript 时，先把 SDK 打进入口再打包：
>
> ```bash
> node_modules/.bin/esbuild src/index.ts --bundle --format=esm --platform=node --target=node20 --outfile=my-plugin/index.mjs
> npx firefly-plugin pack ./my-plugin -o ./dist/my-plugin-1.0.0.ffplugin
> ```

---

## 权限一览与首次调用确认

插件调用宿主能力时，必须在 `firefly.plugin.json` 的 `permissions` 数组中声明对应权限；启用插件时宿主会向用户集中展示所有声明的能力。下表列出 SDK 1.2.0 的全部 9 项权限：

| 权限 | 对应能力 (`ctx.*`) | 是否需要首次调用单独确认 | 说明与约束 |
| --- | --- | --- | --- |
| `model.generate` | `ctx.model.generate` / `generateStream` | 否（启用即授予） | 与 `model.run` 共享每分钟限频（默认 10 次，可在 1–60 间配置），超限抛出 `ERR_RATE_LIMITED` |
| `model.run` | `ctx.model.run` | **是（首次调用确认）** | 启动子代理运行；会展示「插件正在借用模型」指示器与停止按钮，并受限频约束。1.2.0 里需要用户审批的工具操作会被直接拒绝（不会弹审批框，也不会悄悄放行），默认不调用伙伴，`allowPartners: true` 才放开 |
| `events` | `ctx.events.on` | 否（启用即授予） | 订阅宿主脱敏运行事件，单订阅最多缓存 100 条 |
| `sessions.read` | `ctx.sessions.list` / `messages` | **是（首次调用确认）** | 仅读取当前绑定工作区下的公开对话记录，经宿主脱敏 |
| `workspace.read` | `ctx.workspace.current` / `onChange` | **是（首次调用确认）** | 仅读取当前绑定工作区的元数据与变更通知 |
| `schedules` | `ctx.schedules.*` | 否（但任务须审批） | `propose` / `update` 创建或修改后处于 `pending_approval`，需用户在任务面板批准才生效 |
| `notifications` | `ctx.notifications.show` | 否（启用即授予） | 发送纯文本桌面通知 `{ title, body } -> Promise<{ shown: boolean }>`；标题/正文上限 64/256 个 Unicode 码点、每分钟最多 5 次；宿主在标题前加 `〔插件名〕`；系统不支持或用户关闭通知时返回 `{ shown: false }` |
| `secrets` | `ctx.secrets.*` | 否（启用即授予） | 基于系统 `safeStorage` 加密存储凭据；加密不可用时直接失败（`ERR_UNAVAILABLE`），绝不降级明文 |
| `ui.windows` | `ctx.ui.openWindow` | 否（启用即授予） | 打开 `manifest.ui.windows` 中声明的独立窗口；设置页 `ui.settings` 仅需在 `ui.settings` 声明即可收发消息 |

关于**首次调用确认**：
- `sessions.read`、`workspace.read`、`model.run` 除了必须在清单声明并在启用时授予外，在**首次实际调用**时还会弹出一次独立确认框（120 秒超时按拒绝处理并保持未确认状态）。
- 确认状态按授予版本（grant revision）持久化，切会话或重启应用后无需重复确认；但一旦用户在设置页**撤销该权限**、停用插件或升级版本，再次授予时会重新触发首次确认。
- 未在清单声明的能力调用抛出 `ERR_UNDECLARED`；声明但已被用户撤销或拒绝确认抛出 `ERR_PERMISSION`。

桌面通知（`ctx.notifications.show`）调用约定：
- 仅接受 `{ title, body }` 纯文本对象（禁止按钮、链接动作或自定义图标）；去除控制字符后，标题上限 **64** 个 Unicode 码点、正文上限 **256** 个 Unicode 码点（超限报 `ERR_INVALID_ARGUMENT`）。
- 每插件每分钟最多 **5** 次（超限报 `ERR_RATE_LIMITED`）；宿主自动在标题前添加 `〔插件名〕`，点击仅激活 Firefly 主窗口。
- 若系统不支持通知或用户已关闭通知，返回 `{ shown: false }`（不会抛错），插件应做静默降级或兜底处理：

<!-- doc-example: snippet id=readme-notifications -->
```ts
import type { PluginContext } from "@firefly_wu/plugin-sdk";

export async function sendSafeNotification(ctx: PluginContext, title: string, body: string) {
  if (!ctx.has("notifications")) {
    return { sent: false, reason: "no_permission" as const };
  }
  const safeTitle = [...title.trim()].slice(0, 64).join("");
  const safeBody = [...body.trim()].slice(0, 256).join("");
  const { shown } = await ctx.notifications.show({ title: safeTitle, body: safeBody });
  return { sent: shown, reason: shown ? ("shown" as const) : ("suppressed_or_unsupported" as const) };
}
```

工具风险声明与三档权限策略：
- 工具的 `risk` 只能从 `fs-read`、`fs-write`、`shell`、`network`、`input-control` 中选取，**禁止声明 `"safe"`**。
- 宿主提供 `read-only`（只读）、`per-action`（请求审批）、`full`（完全访问）三档权限策略：在 `read-only` 下插件 `shell` 工具也会改为**询问**（因插件不在内置命令沙箱中）。

> 外部聊天渠道（`channels` / `ctx.channels`）：**SDK 接口已提供，桌面接入随 1.2.x 提供**。渠道默认以 **Chat** 模式运行（不挂载工具）；按会话开启 **Work** 后仅放行 `fs-read` 风险工具；审批只在本机宿主完成（不接受外部平台回复审批）；回复发出前先由宿主脱敏。

---

## 工具的四种返回结果（ToolResult）

插件工具的 `execute()` 返回结构化的四态结果 `ToolResult`，宿主不会通过解析文本内容猜测执行成败：

| `status` | 必填字段 | 可选字段 | 语义与宿主行为 |
| --- | --- | --- | --- |
| `"succeeded"` | `output`（字符串或对象） | `summary` | 执行成功；结果返回给模型继续推理 |
| `"failed"` | `error`（字符串） | `retryable`（布尔值） | 执行失败且未产生不可控副作用；`retryable: true` 时模型或上层可决定重试 |
| `"unknown"` | `reason`（字符串） | `possibleEffects` | 副作用不确定（如超时、崩溃或远端请求已发出但未收到回执）；宿主触发不确定状态保护，**禁止自动重试** |
| `"not_executed"` | `reason`（字符串） | — | 执行前即中止（参数校验不通过、执行前已被取消或权限拒绝），未产生副作用 |

<!-- doc-example: snippet id=readme-tool-results -->
```ts
import type { ToolResult } from "@firefly_wu/plugin-sdk";

export function formatResultExample(kind: ToolResult["status"]): ToolResult {
  switch (kind) {
    case "succeeded":
      return { status: "succeeded", output: { ok: true }, summary: "已完成" };
    case "failed":
      return { status: "failed", error: "上游服务返回 503", retryable: true };
    case "unknown":
      return { status: "unknown", reason: "请求超时，远端状态未知", possibleEffects: "可能已创建记录" };
    case "not_executed":
      return { status: "not_executed", reason: "参数校验失败" };
  }
}
```

---

## 使用 `createTestHost()` 测试

`@firefly_wu/plugin-sdk/testing` 提供纯内存的 `createTestHost(options)`，可在 Vitest / Node 中完整验证运行模式（`chat` / `work` / `code`）、权限档位（`read-only` / `per-action` / `full`）、权限撤销、工具取消、进程崩溃以及每一笔调用记录（`host.calls`）：

<!-- doc-example: test id=readme-testhost manifest=readme-minimal plugin=readme-minimal -->
```ts
import { expect } from "vitest";
import { createTestHost } from "@firefly_wu/plugin-sdk/testing";

export async function verifyMinimalPlugin(manifest: any, plugin: any) {
  const host = createTestHost({
    manifest,
    mode: "work",
    level: "full",
  });

  await host.activate(plugin);
  expect(host.status).toBe("active");

  // 1. 正常调用工具
  const ok = await host.callTool("greet", { target: "Firefly" });
  expect(ok).toEqual({
    status: "succeeded",
    output: { greeting: "你好，Firefly！", mode: "work" },
    summary: "已向 Firefly 打招呼",
  });

  // 2. 在 read-only 模式下拒绝 fs-write，放行 fs-read；Chat 模式不支持插件工具
  host.setMode("chat");
  await expect(host.callTool("greet", { target: "Firefly" })).resolves.toMatchObject({
    status: "not_executed",
  });

  // 3. 记录宿主调用并在停用后清理状态
  expect(host.calls.some((c) => c.method === "tools.register")).toBe(true);
  await host.deactivate("disabled");
  expect(host.status).toBe("deactivated");
}
```

---

## CLI 校验与打包（firefly-plugin）

安装 SDK 后可直接运行 `firefly-plugin`（全局或通过 `npx firefly-plugin`）：

```bash
# 1. 校验清单结构（firefly.plugin.json）与包文件边界
npx firefly-plugin validate ./my-plugin

# 2. 指定目标宿主版本进行校验
npx firefly-plugin validate ./my-plugin --host-version 1.2.0

# 3. 校验通过后打成确定性 .ffplugin（ZIP）安装包
npx firefly-plugin pack ./my-plugin -o ./dist/my-plugin-1.0.0.ffplugin
```

退出码约定：
- `0`：校验或打包成功。
- `1`：包不合法（清单校验失败、出现 0.x 字段、使用了 `"safe"` 风险、含符号链接 / junction、未声明 `native: true` 却包含 `.node`/`.dll` 等），`pack` 不会写入任何输出文件。
- `2`：命令行参数用法错误。
- `3`：意外的内部错误。

包边界检查规则：
- `main`（必须为 `.mjs` 或 `.cjs`）、`icon`、`ui.settings.entry`、`ui.windows[].entry` 必须为包根目录内的相对路径，禁止 `..`、绝对路径、盘符、UNC 路径或指向包外的符号链接。
- 包目录内禁止任何符号链接或 Windows junction。
- 输出 `.ffplugin` 路径不能位于插件包目录内部。

---

## 导出入口

- **`@firefly_wu/plugin-sdk`**：
  - `definePlugin(plugin)`
  - `PluginError`、`PLUGIN_ERROR_CODES`、`PluginErrorCode`、`PluginErrorOptions`
  - `PluginContext`、`PluginDefinition`、`Mode`、`RunSource`、`ToolRisk`、`PluginPermission`、`DeactivateReason`、`Disposable`、`ToolResult`、`ToolCall`、`ToolCaller`、`ToolDefinition`、`ToolApprovalDescription` 及各项能力接口类型（`Tools`、`ContextProviders`、`Channels`、`Model`、`Events`、`Sessions`、`Workspace`、`Schedules`、`Notifications`、`NotificationRequest`、`NotificationResult`、`Secrets`、`Ui` 等）
- **`@firefly_wu/plugin-sdk/testing`**：
  - `createTestHost(options)`、`evaluateToolPermission(level, risks)` 及相关测试类型：模拟三种运行模式（`chat`、`work`、`code`）、三种权限档位（`read-only`、`per-action`、`full`）、权限声明与撤销、取消、进程崩溃，并记录插件发起的每一次调用（`host.calls`）。
  - `host.notifications`：记录已展示通知的标题（含真实插件名前缀）和正文；`notificationsSupported: false` 模拟系统不支持通知。`ctx.notifications.show({ title, body })` 需要 `notifications` 权限，每分钟最多 5 条，清理控制字符后标题/正文上限为 64/256 个 Unicode 码点。
- **`firefly-plugin` CLI**：
  - `firefly-plugin validate <目录> [--host-version <版本>]`
  - `firefly-plugin pack <目录> -o <输出文件.ffplugin> [--host-version <版本>]`

---

## 与 0.x 的不兼容说明

Firefly 1.2.0 对插件系统做了彻底重构，**不兼容 0.x 版本**：

1. **清单文件与字段变化**：1.2.0 使用 `firefly.plugin.json` 与 `schemaVersion: 1`，不再识别 0.x 的 `manifest.json`。若清单中出现 `apiVersion`、`entry`、`deps`、`hooks`、`settingsPanel`、`settingsSection`、`defaultEnabled` 等 0.x 字段，校验器会直接返回错误码 `legacy_manifest`（`"这是 0.x 插件，1.2.0 不再支持"`）。
2. **入口与能力接口变化**：1.2.0 使用 `definePlugin({ activate(ctx), deactivate?(reason) })` 与平铺命名空间（`ctx.tools`、`ctx.context`、`ctx.channels`、`ctx.model`、`ctx.events`、`ctx.sessions`、`ctx.workspace`、`ctx.schedules`、`ctx.notifications`、`ctx.secrets`、`ctx.ui`），取代 0.x 的 `register(ctx)` / `unregister()`、`ctx.deps.*` 与 `ctx.storage`。
3. **存储与运行隔离**：1.2.0 使用独立数据目录（Windows 默认 `%APPDATA%\Firefly-1.2.0`），**不读取、不迁移** 1.1.x 的 `plugins/`、`plugin-data/` 以及 0.x 插件。

---

## 信任边界

- Firefly 1.2.0 将已启用插件运行在独立的 Electron `utilityProcess` 中，通过 `MessageChannelMain` 通信，并使用精简环境变量（不继承宿主 `PATH`、`NODE_OPTIONS`、代理设置或宿主凭据）。
- **进程隔离保护的是 Firefly 宿主的稳定性与宿主内部数据，并不是系统级安全沙箱**：插件在其自身进程中依然具备完整的 Node.js 文件系统与网络访问能力。
- 因此，**启用一个插件即意味着信任该插件的代码**。所有本地 `.ffplugin` 或市场插件安装后默认处于**停用**状态，须经用户显式确认可信后才会启用；包含原生二进制（`native: true`，含 `.node`/`.dll`）的插件禁止进入线上目录，仅允许本地安装并在启用时提示高风险。

---

## English Summary

`@firefly_wu/plugin-sdk` is the official SDK for **Firefly 1.2.0** plugins, providing public TypeScript contract types, `definePlugin`, `PluginError`, the in-memory `createTestHost()` testing harness, and the `firefly-plugin` CLI.

- **Install**: `npm install @firefly_wu/plugin-sdk` (or build from the Firefly repo via `pnpm run build:plugin-sdk && npm pack ./plugin-sdk`).
- **Minimal Plugin**: Declare a `firefly.plugin.json` (`schemaVersion: 1`, reverse-domain `id`, SemVer `version` and `sdk`, `.mjs`/`.cjs` `main`, tool `risk` without `"safe"`) and export `definePlugin({ activate(ctx), deactivate?(reason) })`.
- **Permissions & First-Use Confirmations**: Supported `permissions` are `model.generate`, `model.run`, `events`, `sessions.read`, `workspace.read`, `schedules`, `notifications`, `secrets`, and `ui.windows`. Three sensitive permissions — **`sessions.read`**, **`workspace.read`**, and **`model.run`** — additionally prompt the user for a separate **first-use confirmation** on their first invocation (persisted per grant revision; reset on revocation or upgrade).
- **Desktop Notifications (`notifications`)**: Call `ctx.notifications.show({ title, body }) -> Promise<{ shown: boolean }>` (plain text only, up to `64` / `256` Unicode code points after control-character stripping, max `5` calls per minute per plugin). The host prepends `〔Plugin Name〕` to `title`, clicking only focuses the main window, and `{ shown: false }` is returned if unsupported by the OS or disabled by the user.
- **Channels (`channels` / `ctx.channels`)**: The SDK interface is available; desktop wiring arrives in 1.2.x. Channel conversations default to **Chat** mode (no tools); enabling **Work** per conversation allows only `fs-read` tools, approvals happen solely locally on the host (never on external platforms), and outbound replies are redacted before sending.
- **Four `ToolResult` States**: Tool `execute()` returns a discriminated union: `succeeded` (`output`, `summary?`), `failed` (`error`, `retryable?`), `unknown` (`reason`, `possibleEffects?` — host will never auto-retry), or `not_executed` (`reason`).
- **Testing & Packaging**: Import `createTestHost` from `@firefly_wu/plugin-sdk/testing` to test modes, permission levels (`read-only`, `per-action`, `full`), revocation, cancellation, and crashes without Electron. Validate and bundle packages as `.ffplugin` archives using `firefly-plugin validate <dir>` and `firefly-plugin pack <dir> -o <file.ffplugin>`.
- **0.x Incompatibility & Trust Boundary**: 1.2.0 is incompatible with 0.x (`apiVersion: 1`, `manifest.json`, `ctx.deps.*`, `register`/`unregister`) and does not migrate 0.x plugins or 1.1.x plugin data. Plugins run in an isolated Electron `utilityProcess`, **which protects host stability and host data rather than acting as a OS security sandbox** — plugin code still has Node.js filesystem and network access, so **enabling a plugin means trusting its code**.
