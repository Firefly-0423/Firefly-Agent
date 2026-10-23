# 示例走读：system-status（系统状态）

`examples/system-status/` 是 Firefly 维护的一个 JavaScript 示例插件。它覆盖插件能用到的大部分入口：两个 AI 工具（其中一个带参数）、子进程数据采集、独立弹窗、设置页面板和私有 IPC。它是示例，不是沙箱，也不能代替宿主里的端到端验证。

下面的说明以仓库中的文件为准。代码片段都是节选，完整实现请直接读源码。

## 1. 文件清单

```text
system-status/
  manifest.json   # 清单
  index.cjs       # 入口：工具注册、IPC、弹窗生命周期
  ui.html         # 独立弹窗界面（自绘标题栏加数据面板）
  panel.html      # 设置页内嵌面板
  avatar.png      # 插件图标；ui.html 也把它当作头像使用
```

## 2. manifest.json 的各项取值

| 字段 | 取值 | 作用 |
| --- | --- | --- |
| `id` | `system-status` | 决定工具前缀 `system-status_`，以及 IPC 前缀 `plugin:system-status:` |
| `version` | `0.2.0` | 版本号 |
| `author` | `wu02` | 展示字段，显示在卡片上。写你自己的插件时换成你的名称 |
| `icon` | `avatar.png` | 卡片左侧的图标 |
| `settingsPanel` | `panel.html` | 设置页面板。未写 `settingsSection`，因此挂在“插件”分区 |
| `defaultEnabled` | `false` | 对用户插件不起作用。导入后仍然默认停用 |

清单中没有 `deps`。这个示例只用 Node 原生模块、子进程和 Electron 的窗口接口，不需要宿主服务。

## 3. 启动时登记了什么

`register(ctx)` 登记了两个工具和一个 IPC 通道：

| 类别 | 名称 | 说明 |
| --- | --- | --- |
| 工具 | `system-status_status` | 无参数。返回多行文本，用于回答“电脑状态怎么样”一类问题 |
| 工具 | `system-status_disk` | 可选参数 `drive`（盘符字母）。不传时固定查询 C 盘 |
| IPC | `plugin:system-status:snapshot` | 返回结构化快照，供弹窗与设置面板轮询 |

工具的 `description` 写进了用户可能的问法（如“还剩多少电”“开了多久”），这是让模型命中这个工具的关键。`system-status_disk` 的 `drive` 参数先用 `/^[a-z]$/i` 校验，合格后转成大写再拼进 PowerShell 命令，因此不会把任意字符串带进命令。

## 4. 数据采集：原生优先，子进程兜底

采集分为三层。

1. **Node 原生**。`os.cpus()` 两次采样相减得到 CPU 占用；`os.totalmem()` 与 `os.freemem()` 算出内存；`os.uptime()` 给出开机时长。CPU 的首次采样没有基准，返回 null。
2. **GPU 两段式**。先调用 `nvidia-smi` 获取温度、占用与显存。这个命令一旦失败，`nvidiaSmiAvailable` 就被置为 false，之后不再尝试。Windows 上的回退路径读取 `Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine` 的 `UtilizationPercentage` 汇总，只能拿到占用，拿不到温度和显存。
3. **一次 PowerShell 收齐**。磁盘（`Win32_LogicalDisk`）、网络累计字节（`Get-NetAdapterStatistics`）、电池（`Win32_Battery`）和 GPU 引擎计数都放在同一条命令里，输出 JSON 后解析。网络速率是两次累计值之差除以时间间隔，首次为 null。

所有子进程都经过同一个 `runCommand`：使用 `execFile`，设置超时（nvidia-smi 为 3 秒，PowerShell 综合采集为 8 秒，磁盘查询为默认的 5 秒），并带 `windowsHide: true`。失败时返回 `ok: false`，调用方把对应字段留为 null。界面遇到 null 显示“—”，因此任何一项采集失败都不会让面板崩溃。

`collectSnapshot()` 返回的字段包括：`cpuPercent`、`memoryPercent`、`memoryUsedGb`、`memoryTotalGb`、`gpuPercent`、`gpuTemperature`、`vramUsedGb`、`vramTotalGb`、`disks`（最多 6 项）、`networkBytesPerSecond`、`batteryPercent`、`batteryLabel`、`uptime` 与 `cpuModel`。

## 5. 独立弹窗：窗口生命周期

`open()` 的要点：

- 窗口已经存在时只聚焦，不重复创建。判断方法是 `pluginWin && !pluginWin.isDestroyed()`。
- 窗口参数：宽 860、高 600，最小尺寸 380 乘 420，`frame: false`（不要系统标题栏），`autoHideMenuBar: true`，`nodeIntegration: true`，`contextIsolation: false`。
- 自绘标题栏的三个按钮通过 IPC 通知主进程：`plugin:system-status:win-minimize`、`plugin:system-status:win-maximize` 与 `plugin:system-status:win-close`。主进程用 `ipcMain.on` 监听，分别执行最小化、切换最大化和关闭。
- 这三个监听是直接用 `ipcMain.on` 注册的，没有经过 `ctx.registerIpc`，所以框架不会替它清理。示例在窗口的 `closed` 事件中自行调用 `removeListener`。
- `unregister()` 只做一件事：窗口还在时关闭它。关闭会触发 `closed`，监听器随之移除。

`ui.html` 的要点：

- 标题栏是 `.titlebar`，整条设为 `-webkit-app-region: drag`。右侧按钮组 `.titlebar-actions` 设为 `no-drag`，否则点击会被当作拖动。双击标题栏切换最大化。
- 页面定义了全局函数 `window.renderSnapshot(snapshot)` 负责渲染。页面每 3 秒通过 `ipcRenderer.invoke("plugin:system-status:snapshot")` 拉取一次数据，单次失败静默忽略，下一轮再试。
- 头像 `avatar.png` 用相对路径引用，窗口通过 `loadFile` 加载 `ui.html`，因此相对路径可以解析。

## 6. 设置面板：panel.html

- 设置页以 iframe 挂载这个面板。面板只显示四行：CPU 占用、内存占用、开机时长和电池，并注明数据每 5 秒刷新一次。
- 面板引入宿主的官方桥 `/.firefly/panel-bridge.js`，用 `FireflyPanel.invoke("snapshot")` 取数据。它没有使用 `ipcRenderer`。
- 面板运行在沙箱 iframe 中，应只通过 Panel Bridge 与宿主通信。
- 面板没有窗口控制按钮，也没有标题栏。高度由桥自动上报。

## 7. 已知限制

以下限制来自源码与 `examples/README.md`。写自己的插件时要避开，或者在文档里说明。

- CPU 与网络速率的首次采样为 null。GPU 信息依赖 `nvidia-smi` 或 Windows 性能计数器，取不到时为 null。
- `system-status_disk` 不传盘符时固定查询 C 盘，不会枚举全部磁盘，也不会动态识别系统盘。
- 子进程输出按默认字符串方式解码，没有处理其他编码。
- 注册冒烟只能说明 `register` 的契约通过。窗口、真实数据与宿主中的表现，需要在流萤中实测。

## 8. 拿它当模板改

1. 复制整个目录，修改 manifest 的 `id`、`name`、`description` 与 `author`。版本从 `0.1.0` 起步。
2. 全文搜索旧 id，包括工具前缀 `system-status_`、IPC 通道 `plugin:system-status:`，以及 `ui.html`、`panel.html` 中的通道名。
3. 把 `collectSnapshot()` 换成你自己的数据源，同时更新 `ui.html` 与 `panel.html` 的渲染代码。
4. 删除用不到的部分。不需要弹窗，就去掉 `open()`、`ui.html` 与 `avatar.png`（若不再作图标）。不需要设置面板，就去掉 `settingsPanel` 与 `panel.html`。
5. 每改一版，递增版本号。

## 9. 对照示例

- `examples/text-stats/`：纯工具插件，没有窗口和定时器。`unregister()` 通过 `ctx.unregisterTool` 撤销工具。适合作为“只有工具”的最小参考。
- `examples/weather-tool`、`examples/long-term-memory` 与 `examples/scheduled-automation`：TypeScript 示例，分别使用 `secrets`；`llm` 与 `conversations`；`scheduler`。它们的已知限制见 `examples/README.md`。
