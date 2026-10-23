---
name: knowledge-workspace
description: Work 模式下读写已绑定的 Obsidian 知识库（Vault）时遵守的约定：文件分区、按标题取段、写入前的哈希校验与路径边界。
version: 1.0.0
effectKind: mutation
modes:
  - work
tools:
  - obsidian_list_files
  - obsidian_search
  - obsidian_read_file
  - obsidian_read_section
  - obsidian_edit
  - obsidian_open_note
---

# 知识库（Obsidian Vault）操作约定

适用于 Work 会话中的学习类任务。宿主侧关于会话模式、目录绑定、权限与工具注册的规定，优先于本文；本文只说明怎样把这六个工具用对。本规范按需读取，不会自动注入，也不构成运行时门禁。

## 可用条件

- 会话处于 Work 模式，且已绑定一个文件夹。
- 该文件夹里存在 `.obsidian/` 目录，或已有 `learn/progress.md`。
- 条件不满足时，工具会报 `KNOWLEDGE_WORKSPACE_REQUIRED`。此时如实告诉用户缺什么，不要改用 shell 或其它途径直接读写磁盘。

## 目录分工

| 目录 | 用途 | 应当怎样处理 |
| --- | --- | --- |
| `materials/` | 用户放置的原始资料 | 只读；仅在用户明确要求批注时改动。工具层不会替你拦截，靠自律 |
| `notes/` | 学习笔记、概念整理 | 读写 |
| `exercises/` | 练习、测验、错题、复盘 | 读写 |
| `exams/` | 正式试卷、答案解析、考后复盘 | 读写 |
| `templates/` | 用户提供的模板，如 `outline-template.md` | 只读，新建文件时参照 |
| `learn/progress.md` | 学习进度总览 | 权限允许时，教学轮次结束后由应用静默维护；文件不存在时不会被自动创建 |

各分区内的子文件夹由用户自行划分，比如在 `exercises/` 下建一个 `线性代数/`，中文名没有问题。

## 查找内容

1. `obsidian_list_files` 查看整体结构。`relativeDir` 可限定目录，`recursive` 默认开启；只返回 `.md`、`.markdown`、`.mdown`、`.mdx` 文件。
2. 不确定在哪篇时用 `obsidian_search`。它同时匹配文件名、标题和正文，忽略大小写，默认最多 20 条，并标明命中位置（文件名、标题或正文）。
3. 只需要某个知识点时用 `obsidian_read_section`，不要整篇读入。
4. `obsidian_read_file` 的输出附带标题列表，可据此拼出 `headingPath`。

## 按标题取段

`headingPath` 是从最外层标题起的完整路径，逐层列出，例如 `["神经网络", "反向传播"]`，不能只写末级标题。路径必须与文件中的层级逐字一致。找不到时报 `HEADING_NOT_FOUND`，应先用 `obsidian_read_file` 核对标题列表；同一路径出现两次时报 `AMBIGUOUS_HEADING`。

`includeChildren` 决定取到哪里：

- `false`（默认）：只取标题自身的正文；碰到下一个标题（无论级别）就结束，子标题不纳入。
- `true`：连同子标题一起取，直到同级或更高级的标题为止。

示例文件：

```markdown
# 神经网络
## 反向传播
先算损失，再逐层求梯度。
### 链式法则
梯度相乘。
## 优化器
```

- `["神经网络", "反向传播"]` 且 `includeChildren: false`，得到 `## 反向传播` 和它的那一句正文。
- 同一路径且 `includeChildren: true`，还会带上 `### 链式法则` 及其正文，在 `## 优化器` 前停止。

解析器不识别代码围栏，所以正文代码块里以 `# ` 开头的行也会被当成标题。`#` 后没有空格的行不算标题。

## 创建与修改

**新建**：`obsidian_edit` 使用 `create`。目标已存在时直接拒绝（`PATH_ALREADY_EXISTS`），绝不覆盖；父文件夹不存在时，写入流程会自动建立。

**修改已有文件**：

1. 先用 `obsidian_read_file` 读取，记下 contentHash。
2. `replace_file`、`append`、`replace_section`、`append_to_section` 都必须带 `expectedContentHash`。缺失会被拒绝（`CONTENT_HASH_REQUIRED`）；哈希对不上（`CONTENT_CONFLICT`）意味着文件在此期间已被改动，需重新读取后再编辑。
3. 校验的是整篇文件的哈希，不是某个章节的哈希。

各操作的落点：

- `replace_section`：需要 `headingPath`。替换范围是从标题行开始、到下一个标题为止；`includeChildren: true` 时延伸到同级或更高级标题。因此 `content` 要自带标题行（如以 `## 反向传播` 开头），否则标题会被一并替换掉。子章节默认保留；设为 `true` 时子章节也会被替换，需要保留的部分要写回 `content`。
- `append_to_section`：需要 `headingPath`。追加到该章节末尾，位于全部子章节之后。
- `append`：追加到整篇末尾。若文件未以换行结束，会先补一个换行；写入后内容以换行收尾。
- `create`、`replace_file`：`content` 原样写入。

新文件必须带实际内容；只有标题、没有正文的空壳不要落盘。

## 打开笔记

`obsidian_open_note` 会在 Obsidian 应用里打开笔记，可用 `headingPath` 定位到章节。它属于外部副作用，只在用户需要查看，或一轮教学结束后用户要阅读时调用。

## 边界

- 路径只能是 Vault 内的相对路径。绝对路径、`..` 跳出以及经符号链接跳出都会被拒绝（`PATH_OUTSIDE_VAULT`）。
- `.obsidian/` 与 `.firefly/` 下的文件不读不写，列目录时也不显示。
- 只处理 Markdown 扩展名，其它类型报 `FILE_TYPE_NOT_SUPPORTED`。
- 写入类操作由宿主的权限策略决定放行、询问或拒绝（例如逐次询问模式下，每次写入都需要用户确认）。本文不改变这一点。

## 路径模板

- 新主题笔记：`notes/<科目>/<主题>.md`
- 练习或复盘：`exercises/<科目>/<日期>-<主题>.md`
- 试卷：`exams/<科目>/<日期>-<主题>-试卷.md`；配套的答案解析与考后复盘同样放入该科目目录，并沿用同一个「日期-主题」前缀。
- 进度：`learn/progress.md`

`<日期>` 使用 `yyyy-mm-dd`。
