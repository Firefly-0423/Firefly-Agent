# 发布资源

此目录承载 Electron 打包输入及本地辅助资源；是否进入发布包以 `electron-builder.yml` 为准。说明文件需要提交，以下生成或下载的二进制产物不提交。

| 路径 | 来源 | Git 状态 | 用途 |
| --- | --- | --- | --- |
| `bin/firefly-screenshot.exe` | `npm run build:screenshot-helper` | 忽略 | 截图辅助程序；打包时复制到发布包的 `bin/`。 |
| `bin/mpv/` | `scripts/packaging/prepare-mpv.mjs`，清单为 `vendor/mpv-manifest.json` | 忽略 | 飞书音频转码的 mpv 探测路径之一；当前打包配置不复制此目录，QQ Music 不依赖它。 |
| `mingit/` | `npm run prepare:mingit` | 忽略 | MinGit 回退方案；优先使用用户系统已安装的 Git。 |

MinGit 的版本、下载地址与 SHA-256 校验值由 `vendor/mingit-manifest.json` 管理；请更新清单与准备脚本，而不要手动提交 `resources/mingit/` 的文件。mpv 准备脚本保留用于显式本地准备，不在 `package:win:dir` 中运行；探测实现见 `src/main/audio/mpv-binary.ts`，音频转码见 `src/main/channels/adapters/feishu/audio-transcode.ts`。

项目 ZIP 入口使用 `yauzl@3.4.0` 与 `src/shared/zip-extraction.ts`。本说明不等于资源已准备、打包已通过或可以公开分发。
