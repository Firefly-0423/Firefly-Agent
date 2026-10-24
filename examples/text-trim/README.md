# 文本截断（text-trim）

Firefly Plugin API v1 插件，版本 1.0.0。首次安装保持停用，需要用户明确启用。

启用后提供只读工具 `text-trim_cap`，把长文本截断到 UTF-8 字节预算，并报告确切丢弃了多少字节。

参数：

| 参数 | 说明 |
|---|---|
| `text` | 要截断的文本，最多 1,000,000 个字符 |
| `strategy` | `head`（保留开头，默认）、`tail`（保留结尾）、`headTail`（两端） |
| `maxBytes` | `head`、`tail` 必填：保留的最大字节数，非负整数 |
| `headBytes`、`tailBytes` | `headTail` 必填：两端各自的最大字节数；此时不能给 `maxBytes` |

返回：

```json
{ "text": "abc\n[... omitted 5 bytes ...]\nij", "truncated": true, "totalBytes": 10, "keptBytes": 5, "omittedBytes": 5, "notice": "Omitted 5 bytes." }
```

- 预算按 UTF-8 字节计，不是字符数：`é` 2 字节、`世` 3 字节、`😀` 4 字节。切口总落在完整字符边界上，不产生乱码字符；因此保留的字节数可能略小于预算，`omittedBytes` 按实际丢弃的字节计算。
- 单独的代理项码元（不成对的 surrogate）按 3 字节计，与 `TextEncoder` 编码成 U+FFFD 的结果一致。
- 总大小不超过预算（`headTail` 为两端之和）时原样返回，`truncated` 为 `false`。
- `headTail` 在两段之间加入一行 `[... omitted N bytes ...]`，`keptBytes` 只计保留的正文，不含这行标记。
- 参数不合法（非字符串、负数或小数预算、未知 strategy、混用 `maxBytes` 和 `headBytes`/`tailBytes`）时报错，不隐式修正。

## 来源

三种保留策略（`head`、`tail`、`headTail`）、UTF-8 边界规则和 `Omitted N bytes.` 的措辞改编自 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 `packages/util/output-retention`（`TextRetainer`、`describeOmitted`），MIT 许可，`Copyright (c) 2026 DeepSeek`。原库是面向流式输出的累积器，用 `TextEncoder` 处理字节；本插件是一次性的整段文本版本，按码点手工计算字节数，不依赖 `TextEncoder`。`headTail` 的中间标记和工具入口是 Firefly 新写的。随包 LICENSE 保留原版权声明。

## 安全

入口只做内存内计算，不联网、不读写文件、不启动命令、不使用计时器，不持久化或记录输入。停用时注销工具。Firefly 插件在主进程运行并拥有宿主权限；本插件的离线实现不代表宿主提供权限沙箱。

构建：`node scripts/plugin-marketplace/build.mjs`。
