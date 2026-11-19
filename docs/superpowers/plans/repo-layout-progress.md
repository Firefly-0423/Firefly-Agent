# 仓库整体调整：施工进度

日期：2026-11-19
状态：第 1 步（换 pnpm）自动验证通过，打包版实机测试进行中；第 2–6 步未开始
分工：Claude 起草方案并施工，Codex（gpt-6.2-sol，xhigh，只读）评审方案，负责人 hotaru 批准。Gemini 做了改动前的只读调查。

## 方案与负责人决定

方案分 6 步，每步一个 PR，不改产品行为，不动 `src/main` 的七层结构。

| 步 | 内容 |
|---|---|
| 1 | 包管理从 npm 换成 pnpm |
| 2 | SDK 挪到 `packages/plugin-sdk` |
| 3 | 安装资源挪到 `build/installer/`，补 `LICENSES/` |
| 4 | Vite、Vitest 配置改 `.mts` |
| 5 | `CHANGELOG.md` 和 `.versionrc` |
| 6 | 原生程序按模块分目录 |

负责人 2026-11-19 批准的决定：

1. pnpm 用 12.10.1。
2. `node_modules` 用平铺布局（`nodeLinker: hoisted`）。
3. SDK 进 workspace 后只作为成员，应用不依赖它。
4. SDK 安装和构建用 pnpm，发布仍用现在的 `npm publish`（OIDC 免令牌）。
5. 依赖的安装脚本在 `allowBuilds` 里逐个写明，不全局放行。
6. 开发、测试、打包之前显式运行 `pnpm exec install-electron`。
7. `setup.bat` 里注册全局 `firefly` 命令改成可选步骤。
8. 更新日志不改版本号；1.1.4 → 1.2.0 另开 PR。

另外两条要求：SDK 继续发布到 npm，每一步都要核对发布链路；正式出包前，要用打包版实测常用功能，比如上传并处理 Word 文件。

## 第 1 步：换成 pnpm

### 提交

| 提交 | 内容 |
|---|---|
| `build(sdk)` | SDK 的打包和安装检查始终调用真正的 npm。在 `pnpm run` 下，`npm_execpath` 指向的是 pnpm。打包文件清单改为读 `--json`：原来解析的是文本输出，文件列表写在 stderr 里，所以总是拿到空列表、误判通过 |
| `build` | `packageManager` 和 `pnpm-workspace.yaml`；锁文件从 npm 导入后删掉 `package-lock.json`；读锁文件的地方改读 `pnpm-lock.yaml`；5 条 CI 改用 pnpm；`setup.bat`；`.bat` 文件强制 CRLF |
| `docs` | README、开发指南、脚本说明、各层 `AGENTS.md`、插件开发文档里的命令改成 pnpm |

### 与方案的差异和取舍

- **安全补丁没有改成 `patchedDependencies`。** 方案写的是“优先改成 pnpm 的补丁功能”。在平铺布局下，原来的 `postinstall` 脚本照常生效：它先写临时文件再改名替换，不会改到 pnpm 全局仓库里的那份文件；拒绝重定向、校验哈希、重复安装这几项检查都原样保留。所以这一步不改。
- **`allowBuilds` 只有三项。** 原来 `allowScripts` 里的 sharp、tree-sitter、electron 都不需要：sharp 0.35 没有安装脚本，tree-sitter 不在依赖树里，Electron 43.7.0 已经不在安装时下载二进制。
- **`@types/node` 改成直接依赖，固定 20.19.43。** npm 当时把它作为 vite、vitest 的 peer 装在根目录；换成 pnpm 后，这个位置会解析到 25.9.4，主进程类型检查多出 1 个错误。这一步只换工具，所以保持原版本；以后单独换成和运行时一致的 Node 24 类型。
- **`$rxjs`、`$katex` 改成写明版本。** pnpm 12 提示 `$` 写法已废弃。改用 `catalog:` 的话要改 `package.json` 的依赖写法，可能影响 electron-builder，所以直接写成和根依赖一样的版本。
- **依赖版本对照。** 和原来 npm 锁文件比，只有几处在允许范围内的补丁版本不同（jsdom 的 lru-cache 11.5.2→11.5.3，type-is 的 content-type 2.0.0→2.1.0）。另有 132 个其他平台的可选二进制没有装，这是正常的。
- **`pnpm test -- <文件>` 会跑全量。** pnpm 会把 `--` 原样交给 Vitest。文档统一写成 `pnpm test <文件>`。

### CI 修正

- “SDK 检查在发布之前”这条断言，在步骤缺失时也会通过，因为 -1 小于任何位置。现在先断言步骤存在，再比较顺序；反向验证（删掉检查步骤）会失败。
- 新增测试：每条工作流都先装 `packageManager` 指定的 pnpm，再按冻结的锁文件安装，不再用 `npm ci` 或 `npx`。
- 依赖审计改为 `pnpm audit --prod --json`。本机复核结果与 npm 基线一致，同样是 3 个包、11 个公告，已写进 `docs/security/dependency-risk-register.md`。

### 验证（干净的新克隆，2026-11-19）

- 依赖安装：`pnpm install --frozen-lockfile` 通过，安全补丁输出 applied；`pnpm exec install-electron` 通过。
- 三端 `tsc --noEmit` 和 `pnpm run build` 通过。
- `pnpm test`：1141 个文件通过、1 个跳过；15155 项通过、11 项跳过。
- `node --test "scripts/**/*.test.mjs"`：195 项通过。
- `pnpm run check:plugin-sdk`、`test:plugin-examples`、`test:plugin-marketplace`、`build:site` 通过。`build:site` 的产物包含站点和 web-demo 两个构建。
- `pnpm run validate:skills` 通过。
- `pnpm run package:win`：完整 NSIS 安装包打包成功，自带的安装包校验通过。安装包 299,031,227 字节，1.1.4 的 npm 包是 299,021,090 字节；`app.asar` 里的依赖包都是 706 个，名单完全一致。原生模块（ast-grep、sharp、jieba、onnxruntime、playwright）、4 个原生程序、MinGit、许可证文件都在。
- 反向验证：
  - 打包文件清单检查：把 README 改成不允许的文件后，检查报错；
  - 发布顺序断言：删掉 SDK 检查步骤后，测试失败。

打包时 MinGit 下载超时（网络问题，与 pnpm 无关），改用本机另一个工作区缓存的同版本压缩包。打包脚本会按清单重新核对 SHA-256。

### 未验证

- 打包版实机测试：用免安装目录和独立数据目录（`--firefly-profile=smoke --firefly-isolation-root=<目录>`）进行中，结果补在下面。
- NSIS 安装和卸载：按负责人要求不在本机安装，未测。
- CI 在 GitHub 上的实际运行，以 PR 的检查结果为准。
- `setup.bat` 只在测试里用替身命令跑过；`setup.bat link` 会改全局环境，未在本机运行。
- SDK 真实发布：只做了打包检查和外部项目安装，没有发包。

## 第 2–6 步

未开始。
