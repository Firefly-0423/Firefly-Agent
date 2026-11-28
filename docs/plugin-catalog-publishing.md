# 插件在线目录的发布方式

插件市场是独立仓库 [Firefly-0423/firefly-plugins](https://github.com/Firefly-0423/firefly-plugins)。1.2.0 使用独立的 `marketplace-v2` 分支目录。入口和下载规则在 `src/main/features/plugins/host/plugin-marketplace.ts`，由 `src/main/knowledge/skills/external-boundary.test.ts` 核对。

| 内容 | 位置 |
|---|---|
| 目录 | `https://raw.githubusercontent.com/Firefly-0423/firefly-plugins/marketplace-v2/marketplace/registry.json` |
| 插件包 | 同一分支 `marketplace/packages/<id>-<version>.ffplugin`，或现有官方 GitHub Release 资源 |

仓库直装的下载地址由固定目录、已校验的 ID 和版本共同确定，也只允许官方 v2 目录使用。仓库文件禁止重定向。Release 包仍沿用已有的 URL 和重定向校验；两种包均须匹配 SHA-256，并经过同一导入器校验清单、身份和 `native: false`。目录和包有大小与超时上限，首次安装默认停用。

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

在 `firefly-plugins` 的 `marketplace-v2` 上提交插件源码与构建结果。运行 `npm run build` 和 `npm run build:repository-catalog`，一起提交 `marketplace/registry.json` 与新增的 `.ffplugin`，再运行 `npm test` 和 `npm run check`。已经上线的同名包保持原字节；更新插件须提升版本。旧版客户端使用 `main/registry.json`。

若某个插件也要随应用离线提供，再把同一版本复制到本仓库 `examples/<id>/`，并在 `CATALOG_PLUGIN_IDS` 和上表中登记。
