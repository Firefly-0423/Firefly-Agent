# `src/preload/index.ts` 预加载桥拆分重构

状态：已完成（设计、监听统一、拆前保护测试、外围域拆分与 `settings` 拆分 PR 均已合并；Electron 真机全路径联调待实测）  
日期：2026-11-15（设计文档与系列 PR 实施日）

## 为什么做

拆分前（依据 `docs/design/2026-11-15-preload-bridge-split.md`），`src/preload/index.ts` 单个文件长达 1257 行，同时定义了 30 个 `window.*` 暴露对象并挂载已拆出的 `exposeMusicApi()`，向渲染进程暴露合计 31 个全局桥接命名空间，同时内部混合使用 `ipcRenderer.off` 与 `ipcRenderer.removeListener`。大单文件带来三大问题：

1. **安全审计与契约核对成本高**：跨进程暴露面集中在一处超长实现内，仅 `window.settings` 就承担约 370 行、跨越设置弹窗与聊天页运行时交互 6 类职责。
2. **事件注销方式不统一带来测试隐患**：部分测试 mock 仅实现 `ipcRenderer.removeListener` 而无 `off`，混用写法使搬移容易出现 `TypeError: ipcRenderer.off is not a function`。
3. **静态 IPC 扫描兼容性制约**：`src/main/app/ipc-contract-scanner.test-support.ts`（拆分设计撰写时名为 `ipc-contract-scanner.ts`，后随耦合审计 R2 更名）依赖 AST 字面量识别 `ipcRenderer.<op>(IPC.<KEY>)`，随意抽象通用监听 helper 会让全仓 IPC 契约测试漏报。

## 改了什么（前后结构对照）

| 维度 | 拆分前（PR #74 前基线） | 拆分后（PR #86 后 `dc6327a`） |
| --- | --- | --- |
| `src/preload/index.ts` | 1257 行单体脚本，内联 30 个 `window.*` 对象实现 + 调用 `exposeMusicApi()`，保留页面级 `pageTargetKey` | 47 行纯装配入口：生成 `pageTargetKey = crypto.randomUUID()`，从各域工厂构造 API 并集中调用 `contextBridge.exposeInMainWorld(...)`，末尾保留 `exposeMusicApi()` |
| 外围功能域（11 个工厂模块） | 全部内联于 `index.ts` | 拆分为独立纯工厂模块：`pet.ts`、`window-shell.ts`、`chat-media.ts`、`agui.ts`、`appearance.ts`、`plugins.ts`、`scheduler.ts`、`model-config.ts`、`browser.ts`、`memory-user.ts`、`workspace.ts`（沿用既有 `live2d-work-api.ts` 工厂模式；`music.ts` 与独立脚本 `memory-openrouter-once.ts` 保持原位） |
| `window.settings` 桥接（超级对象） | 约 370 行混合 6 类能力写在 `index.ts` 中 | 拆至 `src/preload/settings/` 4 个切片 + 组合入口：`core.ts`、`extensions.ts`、`channels.ts`、`approvals.ts`、`index.ts` |
| 事件监听注销写法 | `index.ts` 内混用 `off` 与 `removeListener` | PR `#76` 先行将全部 34 处事件监听统一为 `removeListener`（新增 `src/main/preload-listener-removal.test.ts`）后再按原样搬移 |
| 暴露面与边界锁网 | 缺少逐方法映射、全部监听注销与全量暴露键锁定测试；部分静态检查仅扫 `index.ts` | PR `#77` 新增 4 组完整保护测试（`preload-exposure-surface.test.ts`、`preload-channel-mapping.test.ts`、`preload-parameter-guards.test.ts`、`preload-event-listeners.test.ts`），并扩展 `ipc-contract.test.ts` 与 `structure-cleanup.test.ts` 递归扫描 `src/preload/` 全部非测试文件 |

## 怎么验证的

1. **拆分前监听统一与保护网锁定**：PR `#76`（`8983810`）添加 `src/main/preload-listener-removal.test.ts`；PR `#77`（`e289ca5`）先锁死 31 个 `window.*` 暴露键集合、全量表驱动方法→通道→参数映射、参数裁剪归一化与 34 处事件监听注销及回调异常隔离。
2. **IPC 静态契约扫描保持零缺口**：遵循 `docs/design/2026-11-15-preload-bridge-split.md` 边界要求，未封装抽象通道 helper，保留直接字面写法 `ipcRenderer.<method>(IPC.<KEY>, ...)`，确保 `ipc-contract-scanner.test-support.ts` 正常工作。
3. **编译与进程边界验证**：按设计文档 §8.1 以 `npm run build:preload`（`tsc -p tsconfig.preload.json`）、`src/shared/process-boundary.test.ts`（确保新子模块不引入 `src/main` 或 `src/renderer`）、preload 专项单元测试与三端检查配合合并流程。

## 涉及的 PR

- **PR `#74`**（`7037948`，2026-11-15）：`docs/split-design-preload`（定稿 `docs/design/2026-11-15-preload-bridge-split.md`）。
- **PR `#76`**（`8983810`，2026-11-15）：`fix/preload-listener-removal`（全部 34 处监听统一为 `removeListener` + `preload-listener-removal.test.ts`）。
- **PR `#77`**（`e289ca5`，2026-11-15）：`feat/preload-split-tests`（preload PR 1：补齐 4 个保护测试文件并扩展 `ipc-contract.test.ts` / `structure-cleanup.test.ts` 扫盘范围）。
- **PR `#85`**（`98c921a`，2026-11-15）：`feat/preload-split-peripheral`（preload PR 2：拆出 11 个外围域工厂模块）。
- **PR `#86`**（`54cc768`，2026-11-15）：`feat/preload-split-settings`（preload PR 3：拆出 `src/preload/settings/` 4 个工厂并收敛 `index.ts` 至 47 行）。

## 遗留事项

1. **渲染侧分散的 `Window` 全局类型声明未整理**：设计文档 §6 PR 3 说明，散落在渲染端的 `Window` 类型声明整理另开后续独立 PR，未混入本次 preload 拆分。
2. **Electron 真机全窗口联调手工清单**：设计文档 §8.2 列出的桌面聊天、桌宠、Live2D、侧栏、设置中心、扩展窗口等真实窗口端到端手工检查待在运行阶段补跑。
