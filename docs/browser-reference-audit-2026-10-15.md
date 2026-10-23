# 浏览器对照与验证边界（2026-10-15）

本轮修复基于 `62550ff4897341b4129462465f610190f82a22c6` 开发，交付移植至 `40d8f695cf604a7a30e47db41b676b95c9eead16`。只包含浏览器观察/操作、显式站点授权、崩溃恢复及连接诊断，不涉及登录策略、Cookie 设置界面或记忆层。

## 公开参考

- [Codex browser 文档](https://developers.openai.com/codex/app/browser)；公开仓库参考版本 `bb64b894fd67158be0f874872e6d7bfe717e7368`。公开文档的能力说明不等于闭源浏览器实现证据。
- [Claude Code Chrome 文档](https://code.claude.com/docs/en/chrome)；公开仓库参考版本 `94506ff0d3bd9185f1752da36e968775021fb48f`。不推断其未公开内部授权或网络实现。
- [Electron 43.7.0 WebContents 文档](https://github.com/electron/electron/blob/v43.7.0/docs/api/web-contents.md)：主框架导航、历史、renderer crash 与固定隔离世界执行的生命周期依据。

## 修改与边界前像审查

隐藏、失焦或覆盖页面使旧观察快照失效；后续 Agent 操作必须针对当前呈现页面。renderer 崩溃立即结束待完成 load/history/DOM Promise，允许后续恢复。显式 Agent 站点与资源授权仍由 Main 原生确认，资源域不能升级为主/子框架导航。搜索仅支持可识别、同主机、单查询字段的 GET 搜索表单，不开放任意提交。

连接诊断仅在已认证 CONNECT 内产生固定分类，经过当前 owner/context/request/target 校验后用于原生 tunnel 失败。刷新/历史保留安全 errno，允许的主框架重定向更新诊断目标。不会透传原始异常、凭据或查询参数作为诊断信息。

`electron-browser-guest.ts` 的 LF SHA256 前像更新为 `e41ced6457c588a582dbf881e1d07ca6b6e5d79cce937ef5dfcb9d0f89baa0de`：相对基线增加 renderer 失效处理、安全失败码与主框架重定向传递。固定 WebPreferences、证书拒绝、弹窗/外部导航边界、隔离世界编号没有放宽。`external-boundary.test.ts` 继续冻结其他边界并测试权限/网络/IPC 生命周期。

## 已知未解决项

1. 已发送给 renderer 的操作可能在隐藏后执行；失效结果或 Promise 取消不能回滚点击副作用。离线真实 guest 队列测试复现了 detach 后副作用，完整服务时序尚未实机证明消除。
2. 多公网 DNS 答案只连接首地址，没有地址回退；首次失败且无成功页面时刷新不可用，地址栏可重新提交。
3. 诊断按主机和导航时段关联，不是 Chromium 主请求级唯一归因；不同原因冲突时退回通用错误。
4. 学校登录页内部导航拦截尚未定位至具体子请求；未放宽登录、iframe、网络或 TLS 策略。

## 验证说明

原隔离集成工作区完成 600 项相关回归、Renderer 类型检查和完整构建。真实离线 Electron fixture 验证 observe/click/type、中英文输入、受限搜索、历史导航、崩溃恢复及内存 Session 隔离。fixture 使用受控协议响应，不是公网 DNS、CONNECT、TLS 或登录验收；未使用个人浏览器档案或凭据。

交付分支上的新测试和构建结果列于 PR。既往全仓库运行存在环境前置失败，不能据相关测试通过声称全仓库全绿。没有以 mock 结果宣称学校或任意公网登录可用。
