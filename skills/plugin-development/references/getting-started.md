# 第一个插件：一个只读工具

目标：做出 `my-first-plugin`。它提供一个“公里换英里”的工具，打包成 ZIP，导入流萤，启用并完成验收。

## 1. 建目录

```text
my-first-plugin/
  manifest.json
  index.cjs
```

需要图标时再加一个 `icon.png`。图标可以是 png、jpg、jpeg、webp 或 svg，大小不超过 2 MiB。

## 2. 写 manifest.json

```json
{
  "apiVersion": 1,
  "id": "my-first-plugin",
  "name": "我的第一个插件",
  "version": "1.0.0",
  "description": "把公里数换算成英里",
  "author": "你的名字",
  "entry": "index.cjs"
}
```

用户插件的 `defaultEnabled` 不起作用：导入后一律停用，所以这里不写它。

## 3. 写 index.cjs

```js
"use strict";

module.exports = {
  register(ctx) {
    ctx.registerTool({
      id: "my-first-plugin_km_to_mile",
      name: "公里换英里",
      description: "用户要把公里数换算成英里时使用。参数 km 是公里数，可以带小数。",
      enabled: true,
      risk: "safe",
      effectKind: "read",
      inputSchema: {
        type: "object",
        properties: {
          km: { type: "number", description: "公里数，例如 10" },
        },
        required: ["km"],
      },
      async execute(args) {
        const km = Number(args.km);
        if (!Number.isFinite(km)) throw new Error("km 必须是有限数字");
        return `${km} 公里约等于 ${(km * 0.621371).toFixed(2)} 英里`;
      },
    });
    ctx.log("my-first-plugin 已注册");
  },
  async unregister() {},
};
```

几点说明：

- `register(ctx)` 在启用时调用一次。工具通过 `ctx.registerTool` 登记，停用时由框架撤销，所以 `unregister()` 可以留空。
- 这个工具只做纯计算，没有副作用，因此 `risk` 取 `safe`，`effectKind` 取 `read`。
- `args` 由模型按照 `inputSchema` 填好传入。参数不合法时直接抛出异常，不要返回误导性的文字。

## 4. 压成 ZIP

在 PowerShell 中，于 `my-first-plugin` 的上一级目录执行：

```powershell
Compress-Archive -Path .\my-first-plugin -DestinationPath .\my-first-plugin-1.0.0.zip
```

这样 ZIP 内是一个 `my-first-plugin/` 文件夹。也可以把 `manifest.json` 和 `index.cjs` 直接放在 ZIP 根目录，两种布局都能被识别。

## 5. 导入并启用

1. 打开流萤聊天窗口里的“功能插件”面板。
2. 点右上角的“添加插件”，选择刚才生成的 ZIP。
3. 新插件默认停用。点卡片上的“启用”，状态会变为“运行中”。

## 6. 验收

- 卡片状态是“运行中”。
- 对流萤说“帮我把 10 公里换算成英里”。她应该调用这个工具，并把结果转述给你。

## 7. 本地冒烟（推荐）

装进流萤之后再排查问题，成本较高。建议先在本地用模拟上下文跑一遍。前两条命令在流萤仓库根目录执行，第三条在插件项目中执行：

```bash
npm run build:plugin-sdk
npm pack ./packages/plugin-sdk
npm install /path/to/firefly-plugin-sdk-0.2.0.tgz
```

然后在插件项目根目录新建 `smoke.cjs`：

```js
const { createMockPluginContext, assertPluginTool, assertValidManifest } = require("@firefly/plugin-sdk/testing");
const manifest = require("./my-first-plugin/manifest.json");
const plugin = require("./my-first-plugin/index.cjs");

(async () => {
  assertValidManifest(manifest);
  const ctx = createMockPluginContext({ pluginId: manifest.id });
  await plugin.register(ctx);
  ctx.tools.forEach((tool) => assertPluginTool(tool, manifest.id));
  console.log(await ctx.tools[0].execute({ km: 10 }));
  await ctx.dispose();
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

运行 `node smoke.cjs`。它能发现工具 id 前缀、manifest 结构和 `execute` 的基本错误。窗口、渠道以及真实存储的问题无法从这里发现，需要在流萤里实测。

## 8. 再加一点：提示词与事件（进阶）

下面两段代码都放在 `register(ctx)` 里。`register` 可以是 `async` 函数。

```js
// 只在对话模式下告诉流萤一个状态（这里是写死的演示文本，真实插件应读取数据源）
ctx.registerPromptProvider({
  id: "focus-timer",
  modes: ["chat"],
  provide({ signal }) {
    if (signal.aborted) return "";
    return "番茄钟：专注中，剩余 12 分钟";
  },
});

// 监听应用退出前的收尾时机，并广播自己的事件
ctx.events.on("host:plugins:stopping", () => {
  ctx.log("应用即将退出");
});
await ctx.events.emit("updated", { value: 1 }); // 订阅方收到 plugin:my-first-plugin:updated
```

## 9. 带界面的插件（要点）

实现了 `open()` 的插件，卡片上才会出现“打开”按钮。最小写法如下：

```js
const path = require("node:path");

let panelWindow = null;

function closePanelWindow() {
  if (panelWindow && !panelWindow.isDestroyed()) panelWindow.close();
  panelWindow = null;
}

module.exports = {
  register(ctx) {
    ctx.registerIpc("ping", () => ({ time: Date.now() }));
  },
  async open() {
    if (panelWindow && !panelWindow.isDestroyed()) {
      panelWindow.focus();
      return;
    }
    const { BrowserWindow } = require("electron");
    panelWindow = new BrowserWindow({
      width: 480,
      height: 360,
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    panelWindow.on("closed", () => { panelWindow = null; });
    await panelWindow.loadFile(path.join(__dirname, "ui.html"));
  },
  unregister() {
    closePanelWindow();
  },
};
```

页面 `ui.html` 通过私有 IPC 取数据，通道名要带完整前缀：

```html
<script>
  const { ipcRenderer } = require("electron");
  ipcRenderer.invoke("plugin:my-first-plugin:ping").then((data) => console.log(data));
</script>
```

注意事项：

- 上面的写法开启了 `nodeIntegration`、关闭了 `contextIsolation`，页面因此拥有 Node 能力。只加载你自己写的文件。
- 无边框窗口（`frame: false`）要自己画标题栏。拖动区域设 `-webkit-app-region: drag`，按钮区域必须设 `no-drag`，否则按钮点不到。
- 如果用 `ipcMain.on` 监听窗口控制按钮，要在窗口的 `closed` 事件里 `removeListener`。这类直接注册的监听器不经过 `ctx`，框架不会替你清理。

完整的无边框窗口写法见 `references/example-walkthrough.md`。

## 10. 数据采集的小建议

- 优先使用 `os`（如 `os.cpus()`、`os.totalmem()`）和 `fs` 等 Node 原生接口，零依赖也更稳。
- 不够时再调用子进程，例如 Windows 上的 PowerShell 或 `nvidia-smi`。使用 `execFile` 并传入参数数组，设置超时，失败时降级。
- CPU 占用、网络速率这类差分值，要两次采样相减再除以时间间隔。首次采样没有基准，应返回 null，界面显示为“—”。
- `system-status` 的 `runCommand` 使用 `execFile`，带 `windowsHide: true`，输出按默认方式解码。它没有处理 GBK 或 `windowsVerbatimArguments`，不要把这些当成示例已经提供的保证。

## 11. 常见问题速查

| 现象 | 常见原因 | 处理 |
| --- | --- | --- |
| 启用失败，提示工具 id 必须以某前缀开头 | 工具 id 没有 `<插件id>_` 前缀 | 改成 `<插件id>_xxx` |
| 启用失败，提示 version 必须是合法 SemVer | 写成了 `1.0` 或 `v1.0` | 改成 `1.0.0` |
| 启用失败，提示 manifest 结构不合法 | 字段类型错误、缺少必填项、有未知字段，或 deps 拼错 | 对照 `api-spec.md` 的字段表；deps 只能取 `channels`、`llm`、`secrets`、`workspace`、`conversations`、`scheduler` |
| 提示入口文件不存在，或 entry 必须是裸文件名 | entry 含子目录，或者文件名与实际不符 | entry 只写文件名，且文件确实在插件目录根下 |
| 提示不兼容的 apiVersion | apiVersion 不是 1 | 改为 `1` |
| 提示入口未导出 register() | 入口没有导出包含 `register` 函数的对象 | 检查 `module.exports` |
| 提示工具 id 已被占用 | 与内置工具或其他插件的工具重名 | 换成带自己前缀的 id |
| 启用成功，但流萤从不调用工具 | `description` 没有写清使用场景 | 写明场景与参数含义 |
| 改了代码没有生效 | 没有刷新插件 | 点“刷新插件” |
| 扫描提示缺少 manifest.json | ZIP 或目录多套、少套了一层 | manifest.json 放在根目录，或放在唯一的顶层文件夹里 |
| 卡片显示“启动失败” | `register` 抛错，或激活超过 10 秒 | 看卡片上的错误文字，修复后点“重试” |
| 弹窗白屏 | 通道名拼错，或 HTML 路径不对 | 打开开发者工具查看渲染进程的报错 |
