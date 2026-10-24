# 插件在线目录的发布方式

插件市场是独立仓库 [Firefly-0423/firefly-plugins](https://github.com/Firefly-0423/firefly-plugins)：插件源码、目录文件和发布流程都在那里。应用只认下面两个地址，写在 `src/main/plugin-host/plugin-marketplace.ts`，改动它们属于安全边界变更，需要同时更新 `src/main/skills/external-boundary.test.ts` 里的固定哈希。

| 内容 | 位置 |
|---|---|
| 目录 | `firefly-plugins` 仓库 `main` 分支的 `registry.json`：`https://raw.githubusercontent.com/Firefly-0423/firefly-plugins/main/registry.json` |
| 插件包 | `firefly-plugins` 仓库的 GitHub Release 资源，前缀 `https://github.com/Firefly-0423/firefly-plugins/releases/download/`，tag 为 `<id>-<version>` |

安全边界：目录里的每个条目都固定了包的 SHA-256，应用下载后不匹配就拒绝；只接受上面这个 Release 前缀，重定向只允许跳到 GitHub Release 资源的下载域；目录和包都有大小与超时上限；安装后的插件默认停用。旧的 `Serendipity-wu02/Firefly_Agent` Release 地址不再被接受。

## 随应用的离线目录

应用还带一份离线目录（网络不可用时显示），由本仓库的 `scripts/plugin-marketplace/build.mjs` 从 `examples/<id>/` 生成，写入 `resources/plugin-marketplace/`。离线目录与线上目录使用同一套打包规则（STORE、固定 1980 时间戳、固定文件列表），相同源码输入生成的包字节一致。下表是本地重新生成的离线包哈希；构建不会更新已托管的目录或 Release：

| 插件 | 版本 | Release tag | ZIP SHA-256 |
|---|---|---|---|
| `text-stats` | 1.0.1 | `text-stats-1.0.1` | `7ecf64d2f6f2437c9bbac8ec69faf5b1f9ed7829360f25c38f1c6d851f0ceeab` |
| `json-tools` | 1.0.1 | `json-tools-1.0.1` | `2518b63cbc3bdbb3fcb9206a42a6f036af989f0925871c6c92514b7ba1940668` |
| `timezone-tools` | 1.0.1 | `timezone-tools-1.0.1` | `5438ba4a88cda3747b3db159813f582038e042ad6150f5fbd507545f8b3e4ae5` |
| `code-language` | 1.0.1 | `code-language-1.0.1` | `e89243dedc4b3803162c10b80688c9e49f91165bb56f4a93208b6343783e8e53` |
| `text-trim` | 1.0.1 | `text-trim-1.0.1` | `a9e3175425a5f0f753808cb6961b70d1413d8e4e84a2edfa95294c23ee1c9a20` |

## 发布新插件或新版本

在 `firefly-plugins` 仓库里进行，步骤见该仓库的 README 和 CONTRIBUTING：提交插件源码的 PR，CI 校验并生成目录；合并后由维护者手动运行 Release 工作流，为尚未发布的 `<id>-<version>` 创建 Release 并核对哈希。已发布版本的字节不得再变，任何改动都需要新版本号。

若某个插件也要随应用离线提供，再把同一版本复制到本仓库 `examples/<id>/`，并在 `CATALOG_PLUGIN_IDS` 和上表中登记。
