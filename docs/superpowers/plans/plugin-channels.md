# C12 插件渠道宿主施工记录

状态：实现完成，验证结果见管理工作区 `output/codex-report-plugin-channels.md`。

范围：共享协议中的三个 `channels.*` 宿主 RPC、三个 `channel.*` 插件调用，
渠道声明、生命周期、消息隔离、受限 Work 工具调度、本机审批适配与发送不确定结果。
按现有 C12 交接施工；不增加设置 UI，不替换现有 QQ/飞书渠道，不推送或发布。

基线：起始 `46f7599`；通过可恢复 stash 保护工作后，merge 最新 dev
`fafa7ad`（含 C10 #132），恢复时仅宿主测试冲突，保留双方全部测试。

- [x] 先写声明、模式、工具双重限制、转义、附件上限、停用、崩溃发送测试。
- [x] 实现显式依赖的渠道服务，复用 shared external-data policy 与 envelope。
- [x] 添加独立 stop hook，和 C10 configureRpc disposer 并存。
- [x] 用 G36 SDK proxy 对接三个 RPC，并覆盖停用后重注册、取消与 unknown 记录。
- [x] 反向验证发送崩溃、stop hook、模式撤销和不响应取消的 runner，再验证修复。

验证流程：先定向测试，再三端构建与 storage boundary，最后从本地提交的最终 HEAD
启动全量测试。最终统计和日志位置只记录在管理报告，避免为了更新统计再次修改待验 HEAD。

裁定：URL 附件无法在不取回数据时核实大小，因此拒绝；二进制附件只在总量校验后
复制到 untrustedAttachments，解码交受信 runner。模式在宿主 API 中按会话配置，
没有外部变更或外部批准接口。应用 runner、本机审批 UI、持久化审计由后续装配提供，
本包不使用默认允许替身。现有渠道继续走原模块，v2 插件渠道单独装配。
