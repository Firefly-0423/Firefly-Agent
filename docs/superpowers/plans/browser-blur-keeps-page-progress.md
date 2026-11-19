# 浏览器失焦不清空页面：验证报告

日期：2026-11-19
状态：自动验证通过；Win+Shift+S 实机待测
设计：[浏览器归属与会话](../../design/browser-owner-and-session.md)；施工计划：[browser-owner-and-session.md](./browser-owner-and-session.md) 的 PR A 验收“失焦不清空页面”。
分工：Codex 实现，Claude 复核、反向验证和整理提交。

## 问题

负责人实机反馈：主窗口只是失去焦点（例如 Win+Shift+S 截图、切到别的程序）而仍然可见时，右侧浏览器变成空白。原因是 `browser-service.ts` 在窗口 `blur` 时就把网页视图摘下，“是否显示”和“代理能否操作”共用同一个焦点判断。

## 改动

`src/main/platform/browser/browser-service.ts`：

- 显示和操作分开判断：
  - `hostVisible` 只看窗口是否可见、是否最小化；
  - 新增 `hostInteractive`，在此基础上还要求窗口有焦点。代理的点击、输入、观察等操作仍然用它判断。
- `blur` 不再摘视图，只让已保存的观察和正在进行的观察失效。恢复焦点后，代理必须重新观察才能点击。
- 新增 `minimize`/`restore` 监听：最小化时摘下视图，还原后按下一次可信布局挂回。隐藏（`hide`）的处理不变。

这是 PR A 里的一处窄修复，不包含 A2 的“后台允许只读观察”；失焦期间代理的所有页面操作仍被拒绝，比 A2 的设计更严。

## 自动验证（合并最新 dev 之后）

- 浏览器服务测试 103 项通过。
- 反向验证：把 `blur` 改回摘视图后，测试立即失败（1 项）。
- `npm test`：1141 个文件通过、1 个跳过；15140 项通过、11 项跳过。
- 三端 `tsc --noEmit` 和 `npm run build` 通过。

Codex 另外用构建出的浏览器服务、真实 Electron 窗口和本地网页验证过：切到另一个窗口后原网页仍在；最小化后视图摘除；还原后挂回同一个视图。

## 未覆盖

- 开发版里按 Win+Shift+S 的实机检查：Claude 测试时电脑处于锁屏，没有测到，待补。
- 打包版未测。
