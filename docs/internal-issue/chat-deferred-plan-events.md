# Chat 模式曾接收延迟计划事件

状态：已修复，待合并。更新于 2026-11-19。

修复前，Chat 和 Code 都订阅延迟计划事件。计划批准或补充事件可能触发 Chat 自动发送下一条消息。现在仅 Code 订阅这些事件、读取计划上下文并启动计划评审。Chat 收到旧的完成事件或模型请求调用计划工具时，也不会进入计划流程。已有计划的只读权限保护继续生效。

见 [ChatPage 回归进度 C12](../superpowers/plans/chatpage-regression-progress.md)。
