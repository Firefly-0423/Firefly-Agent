# 插件在线目录的发布方式

插件市场是独立仓库 [Firefly-0423/firefly-plugins](https://github.com/Firefly-0423/firefly-plugins)：插件源码、目录文件和发布流程都在那里。应用只认下面两个地址，写在 `src/main/plugin-host/plugin-marketplace.ts`，改动它们属于安全边界变更，需要同时更新 `src/main/skills/external-boundary.test.ts` 里的固定哈希。

| 内容 | 位置 |
|---|---|
| 目录 | `firefly-plugins` 仓库 `main` 分支的 `registry.json`：`https://raw.githubusercontent.com/Firefly-0423/firefly-plugins/main/registry.json` |
| 插件包 | `firefly-plugins` 仓库的 GitHub Release 资源，前缀 `https://github.com/Firefly-0423/firefly-plugins/releases/download/`，tag 为 `<id>-<version>` |

安全边界：目录里的每个条目都固定了包的 SHA-256，应用下载后不匹配就拒绝；只接受上面这个 Release 前缀，重定向只允许跳到 GitHub Release 资源的下载域；目录和包都有大小与超时上限；安装后的插件默认停用。旧的 `Serendipity-wu02/Firefly_Agent` Release 地址不再被接受。

## 随应用的离线目录

应用还带一份离线目录（网络不可用时显示），由本仓库的 `scripts/plugin-marketplace/build.mjs`（`pnpm run build:plugin-marketplace`）从 `examples/<目录>/` 生成，写入 `resources/plugin-marketplace/`，`build:main` 再把它复制到 `dist/main/plugin-marketplace/`，应用以此作为 `bundledDir`。

输出是协议 v2：`registry.json` 的 `apiVersion` 为 `2`，每个条目含 `id`、`name`、`version`、`sdk`、`description`、`author`、`license`、`native: false`、`permissions`、`tools`、`capabilities`、`package` 和 `sha256`。`package` 在离线目录里是 `bundled:<包文件名>`，公开模式下是 `<Release 前缀><tag>/<包文件名>`。包是 `<id>-<version>.ffplugin`，由应用自己的 `packPackage`（`src/plugins/v2/package/pack.ts`）打成，清单用 `validateManifest` 校验，所以字节与应用内打包一致；固定条目时间戳和文件列表，相同源码输入生成的包字节一致。每个插件目录含 `firefly.plugin.json`、`index.mjs`、`README.md`、`LICENSE`，另有只供目录条目使用、不进入包的 `catalog.json`。下表是本地重新生成的离线包哈希；构建不会更新已托管的目录或 Release：

| 插件 | 版本 | Release tag | 包 SHA-256 |
|---|---|---|---|
| `dev.firefly.text-stats` | 1.0.1 | `dev.firefly.text-stats-1.0.1` | `1a7f8c16adc83229e713dfa403f75a189d6767dfa634dc01475c2abd6fa7d38b` |
| `dev.firefly.json-tools` | 1.0.1 | `dev.firefly.json-tools-1.0.1` | `209771c3c611efad17b58f360a18c83af9c9c69d6c7d38538da983237713ced6` |
| `dev.firefly.timezone-tools` | 1.0.1 | `dev.firefly.timezone-tools-1.0.1` | `622e57999ea532a870c0b01b68a96fb79945ae013fed0a3120b2af4576653ea7` |
| `dev.firefly.code-language` | 1.0.1 | `dev.firefly.code-language-1.0.1` | `87a0ae5e62eac37144b4575e154954ba62cc202cbc8e2373b505bf838f96d689` |
| `dev.firefly.text-trim` | 1.0.1 | `dev.firefly.text-trim-1.0.1` | `9b3cb52c4321b09ee221ebefdd2bd5c1fb25781183e0acb04f16cdae5737a616` |

## 发布新插件或新版本

在 `firefly-plugins` 仓库里进行，步骤见该仓库的 README 和 CONTRIBUTING：提交插件源码的 PR，CI 校验并生成目录；合并后由维护者手动运行 Release 工作流，为尚未发布的 `<id>-<version>` 创建 Release 并核对哈希。已发布版本的字节不得再变，任何改动都需要新版本号。

若某个插件也要随应用离线提供，再把同一版本复制到本仓库 `examples/<id>/`，并在 `CATALOG_PLUGIN_IDS` 和上表中登记。
