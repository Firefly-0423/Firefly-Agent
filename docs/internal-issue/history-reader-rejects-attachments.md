# 项目历史含附件时，新任务无法开始

2026-11-19。状态：已修复，待合并和打包复测。

在 Work 会话上传文档，随后在同一项目新开 Work 或 Code 任务。打包版反馈显示 E_CONTEXT_FAILURE，原因是 MEMORY_HISTORY_FORMAT_UNSUPPORTED。触发条件是新任务读到带附件的旧会话，无需再次上传。

记录写入端正常保存附件描述。历史读取器却把任何非空附件列表当成未知格式，连正文也无法检索。修复覆盖普通用户消息、编辑后的替换消息和旧聊天文件。仅接受有合法类型、名称和路径的附件描述；投影只取可见正文，附件名、路径和说明不参与检索。带附件的旧聊天消息也不会投影派生的 modelContext。

读取器与跨会话模型请求测试 61 项通过。反向恢复旧读取器后，普通或替换条目、聊天文件回退、跨会话模型请求三个场景再次失败。打包版同项目新任务及大文档入库需另行验收。

## 生产历史的收录条件与验证

读取器可以解析带附件用户消息的可见正文。生产运行捕获不会给这类轮次登记直接用户来源凭据，原生历史提供器因此排除该轮次，返回部分覆盖及 MEMORY_HISTORY_ORIGIN_UNPROVEN。同一项目旧会话里其他有凭据的轮次仍可被新任务检索。默认原生路径读取 transcript.jsonl 与 snapshot.json，旧聊天 JSON 仅是读取器的兼容回退。

定向运行 npm test -- src/main/memory/context/smh-integration.test.ts src/main/memory/history/firefly-history-reader.test.ts，共 93 项通过。暂时恢复旧读取器，再运行 npm test -- src/main/memory/context/smh-integration.test.ts -t "a new task sends proven project history"，该用例以 MEMORY_HISTORY_FORMAT_UNSUPPORTED 失败。恢复修复后通过。打包版实机复测待做。
