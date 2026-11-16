状态：设计提案（现状整理）
实现状态：已实现

# Firefly 主进程组合根与生命周期

核对基线：`dev/docs-design`，`dc6327a`。本文依据当前源码及测试定义整理；“已实现”仅表示有代码依据，本次未运行产品测试、构建或界面验收。

## 解决的问题
把启动、依赖注入、窗口就绪和退出顺序收口，业务留在各层。本文合并原生命周期验收说明，验收要求不作为运行通过记录。

## 当前实现
`src/main/index.ts` 经 `src/main/base/identity/startup-entry.ts` 分流普通与诊断入口；普通路径为 `src/main/app/normal-main.ts`。后者完成 ready 前准备，再启动 `src/main/app/application.ts` 的 `createApplication`，生产依赖由 `src/main/app/default-dependencies.ts` 注入。

| 阶段 | 实现与边界 |
|---|---|
| ready 前 | `src/main/app/pre-ready.ts` 处理单实例和协议等配置。 |
| shell | `src/main/app/shell-bootstrap.ts` 创建 Loading、IPC scope、聊天壳和激活接线；激活代理见 `src/main/platform/windows/window-activation.ts`。 |
| core | `src/main/app/core-bootstrap.ts` 的 `startCore` 等待内置渠道登记，再启动插件和核心 IPC、加载聊天页面，最后放行激活。 |
| background | `src/main/app/background.ts` 的 `startBackground` 运行四组后台任务；MCP restore 有 30 秒屏障。 |
| 基础状态 | `src/main/base/lifecycle/readiness.ts` 的 `StartupReadiness` 分开保存阶段和降级原因。 |

## 行为与失败边界
技能、沙箱、RAG 的 softStep 失败可降级；核心运行时或页面加载失败向顶层传播。core 创建桌宠窗口并传入 petVisible，隐藏配置不是“不创建窗口”。聊天可显示后才等待后台全部落定；30 秒只限定 MCP restore 屏障，不保证所有后台工作三十秒结束。

`src/main/base/lifecycle/shutdown.ts` 的 `createShutdownCoordinator` 按 quiesce、stopProducers、stopActiveWork、stopExternalConsumers、stopExternalProviders、stopLocalResources、flushPersistence 顺序清理；同阶段 allSettled，默认总等待 10 秒。超时发信号并结束等待，不证明底层资源均已释放。beforeShutdown 拒绝时不进入停止流程。

`src/main/app/electron-lifecycle.ts` 处理普通退出与系统会话结束，紧急同步 flush 不能替代完整异步关闭。数据根由 `src/main/base/identity/runtime-profile.ts` 消费 `src/main/base/identity/data-directory.ts`，正式目录已是 `Firefly-1.2.0`；应用名称仍为 Firefly，二者不能混淆。

## 未完成与维护验证
后续会话库启动、停止接纳与关闭由[会话可靠性计划](../superpowers/plans/2026-11-12-conversation-reliability.md)承接；精确提醒投递由[提醒与界面计划](../superpowers/plans/2026-11-12-reminders-and-ui.md)承接。代码接线存在不代表所有资源与真实系统退出已验收。

最近测试目录为 `src/main/app/`、`src/main/base/lifecycle/`。重点核对：核心失败不放行、隐藏桌宠不闪现、迟到后台资源归属、拒绝退出无清理、同阶段失败继续、超时不虚报完成。开发态与打包态的窗口重建、真实系统退出未在本次验证。
