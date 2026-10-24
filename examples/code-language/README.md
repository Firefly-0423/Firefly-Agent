# 代码语言识别（code-language）

Firefly Plugin API v1 插件，版本 1.0.0。首次安装保持停用，需要用户明确启用。

启用后提供只读工具 `code-language_detect`，按文件名里的扩展名识别语法高亮语言，不读取文件内容。

参数 `{ "paths": ["src/app.ts", "C:\\dir\\main.PS1", ".env"] }`，1 到 200 项，每项最多 1024 个字符。返回：

```json
{ "results": [
  { "path": "src/app.ts", "language": "typescript", "shortName": "ts" },
  { "path": "C:\\dir\\main.PS1", "language": "powershell", "shortName": "ps1" },
  { "path": ".env", "language": "dotenv", "shortName": "env" }
] }
```

- `language` 是语法高亮语法的 id（如 `shellscript`、`system-verilog`），`shortName` 是短名（如 `sh`、`sv`；`tsx`、`jsx`、`tf`、`tfvars`、`gradle` 保留自己的后缀）。
- 取最后一段文件名里最后一个点之后的文字，不区分大小写；同时识别 `/` 和 `\`。开头的点也算分隔符，所以 `.env` 是 `dotenv`。
- 未收录的扩展名、没有扩展名的名字（`Makefile`、`Dockerfile`、`.gitignore`）、结尾是点的名字，以及 `foo.constructor`、`foo.__proto__` 这类名字都返回 `null`。证书和锁文件扩展名（`pem`、`crt`、`key`、`cer`、`lock`）有意不收录。
- 共 61 种语言、115 个扩展名；这是精选表，不是完整的语言注册表，也不嗅探内容。

## 来源

扩展名表（含短名表）原样复制自 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 `packages/util/code-language/src/index.ts`（提交 `86a402200d95fecef4529d969836f1fe13c6cb0d`），查找逻辑是 `languageForPath` 和 `readLangHintForPath` 的 JavaScript 移植，MIT 许可，`Copyright (c) 2026 DeepSeek`。工具入口、参数校验和结果格式是 Firefly 新写的。随包 LICENSE 保留原版权声明。

## 安全

入口只做内存内计算，不联网、不读写文件、不启动命令、不使用计时器，不持久化或记录输入。停用时注销工具。Firefly 插件在主进程运行并拥有宿主权限；本插件的离线实现不代表宿主提供权限沙箱。

构建：`node scripts/plugin-marketplace/build.mjs`。
