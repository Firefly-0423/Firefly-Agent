# 外部技能市场：固定版本与纯文本兼容范围

来源固定为 `openai/plugins` 与 `anthropics/skills`。来源的官方身份、包名、版本、许可证声明或源宿主审核，均不能代替 Firefly 的完整内容审核。

| 身份 | 数据来源 | 含义 |
| --- | --- | --- |
| 最新发现 | 当前目录解析得到的固定提交 | 只说明发现了此版本；更新不继承旧审核 |
| 已审核固定快照 | Main 静态审核表中当前政策下唯一最新的记录 | 绑定来源、提交、路径、完整文件摘要和政策；准备导入时仍重新核验 |
| 已安装版本 | committed 记录、所有权标记与完整安装文件均通过证明 | 与目录和审批独立；显示实际启用状态，旧安装器未记录政策时明确标为未记录 |

选择版本只向 Main 提交 `latest` 或 `reviewed` 及界面显示的期望提交。Main 自己选择目录和审批，拒绝任意提交、路径、政策或确认标志。一个来源最多保留 latest、reviewed 各一个快照，共四个；切换审核提交、刷新和窗口生命周期继续使旧操作与 token 失效。最新目录删去某条技能，或成为合法空目录时，旧审核条目仍保留。网络、目录解析错误继续显式报错；本批未实现离线目录或持久化下载缓存。

导入仍使用完整目录，不删除不兼容文件、不改写正文、不继承其他宿主的工具权限。`prepare` 只在完整校验及已有静态审批均满足后创建暂存；`commit` 仍需一次性 token，默认禁用；启用仍在已安装技能列表单独确认。已有目标继续返回 `TARGET_EXISTS`，本批不自动覆盖、升级或回退已安装内容。

## 被动格式适配

| 格式 | 技能入口 | 本批支持 |
| --- | --- | --- |
| OpenAI portable | 包根 `plugin.json`，固定 `skills/<name>/SKILL.md` | 读取身份及元数据；根 `extensions.com.openai` 覆盖整个旧 overlay，否则读取 `.codex-plugin/plugin.json` 回退；不合并执行组件 |
| Codex compatibility | `.codex-plugin/plugin.json` 的局部 `skills` 路径 | 保持旧声明支持；检查顶层和内嵌 OpenAI 扩展的组件 |
| Claude | `.claude-plugin/plugin.json`、标准 `skills/` 和 manifest/目录追加的局部技能路径 | 支持同一固定仓库内的局部包；无 manifest 时支持标准布局及当前 Anthropic 显式目录 |

Claude 的仓库根来源若显式列出技能，则只发现并核对这些目录，存在 manifest 也不扩大选择；普通子目录包继续支持默认目录与额外目录。manifest 存在且 `strict:false` 的目录条目再次声明组件时，标为冲突并阻断。OpenAI portable 的兼容回退与独立 Codex manifest 共用嵌套扩展检查，内联 overlay 的额外扩展嵌套不能隐藏执行组件。所有实际读取的包许可声明都沿用同一许可集合检查，目录展示值不能遮盖 manifest/overlay 中不支持的声明；这不替代逐文件许可覆盖审核。

只支持 `SKILL.md`、同目录适用许可/NOTICE 文本，以及直接位于 `references/` 的 `.md`/`.txt`。全部文件都必须是普通 Git 文件、可接受的 UTF-8 文本，并满足现有数量、体积、路径和 hash 限制。许可证仍须由静态审核记录逐文件覆盖，不能仅凭 MIT 等声明导入。初始命名政策为 `firefly-instruction-only-v1`；政策缺失或不一致时需要重新审核。

非空 MCP、hooks、commands、agents、LSP、工作流、依赖、安装配置等声明，以及默认执行组件位置，都会阻断原候选并显示组件/路径。`mcp.json`、`.mcp.json` 中空的 `mcpServers` 对象是无操作配置；解析不会连接服务器、展开变量、读取凭据或创建进程。脚本、二进制、宿主专用 frontmatter、必需外部能力与无法满足的引用继续阻断。没有自动生成“去脚本版”；此类衍生物应拥有独立身份、缺失能力标注和新的完整审批。

界面同时显示 `DEPENDENCY_BLOCKED` 与 `REVIEW_REQUIRED` 表示已经确认的不兼容和仍缺少的精确审批，两者可同时成立。完整审核失败后重新获取当前详情，展示具体已知原因；网络/限流失败或快照失效时清除旧可操作预览并要求手动刷新。旧异步响应不得覆盖新来源或版本。外部市场的 Work/Code 文案与已安装列表的当前模式切换独立。

## Remotion 固定快照核验

`remotion-markup` 在 `0722921d5542fc593105c27bd52630babd8b8c2a` 的 58 个原文件共 561339 字节，规范摘要仍为 `be1b704d0941cf8537a91753714e54705a74e6b88245d3c314b21aeb474e614d`。使用本分支编译后的真实生产 manifest/frontmatter/review 模块，以之前只读取得的固定字节与 Git 树注入 blob 读取器，结果仍为声明核对通过、审核阻断、`DEPENDENCY_BLOCKED` 与 `REVIEW_REQUIRED`。

本次实际返回 57 个不支持的文件记录、2 个非文本记录、18 个指令依赖记录（同一文件可能属于多个类别）。其平铺 Markdown 附件、脚本、图片、JSON/GeoJSON 和必需运行时/其他技能均不能直接变为此宿主支持的文本载荷。没有安装或运行候选。该验证覆盖生产解析及审核模块，不代表 Electron UI、真实网络下载或实际导入已验收。

Claude 包版本采用 manifest、目录条目、目录公共元数据的优先级；固定提交和内容摘要仍是独立身份。manifest/config 的文件模式不支持时，在读取正文前返回阻断详情，只显示经过验证的仓库相对路径和 `file-mode` 原因，保持先前已知组件阻断；不会返回本机暂存或配置路径。声明仍为 blocked，不能暂存或导入。旧版第一批报告中的两项轻微问题由后续回归修复，其历史测试记录保留。

## 格式依据

- [OpenAI Package your plugin](https://developers.openai.com/plugins/build/plugins)：portable 根 manifest、固定组件位置与 overlay 优先级。
- [Submit a Claude plugin to OpenAI](https://developers.openai.com/plugins/guides/submit-claude-plugin)：审批不跨宿主转移，文本工作流与 MCP 转换分别处理。
- [Claude plugin manifest reference](https://code.claude.com/docs/en/plugins-reference)：可选 manifest、标准/额外技能路径、目录声明和其他宿主组件。

这些上游文档描述各自完整宿主能力；本实现仅采用上述保守纯文本部分。Firefly 已有的 MCP 连接/调用链路与此导入器分离，本批不重建 MCP，不接入真实设备，也不增加执行沙箱或权限。
