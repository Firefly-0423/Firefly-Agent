# Firefly 开发说明

自有 Skills 使用 `firefly-*` 名称；旧 ID 只用于兼容已有设置和命令，不再作为内置目录名。

项目以 Electron、TypeScript、React 和既有 Agent 运行架构为基础。当前功能边界见 [README](./README.md)；历史阶段结论从归档索引查阅，不作为当前操作指南。远程旧版 Firefly 的 Python 入口和测试脚本不再属于当前运行链。

## 环境与构建

需要 Windows、Node.js 24、npm 10 及项目锁文件对应的依赖。

```powershell
npm ci
npm run check:renderer
npm run build
```

`npm run build` 生成 Main、Preload、CLI 和 Renderer，不制作安装器。开发模式使用 `npm run dev`。单元测试使用 `npm test`，局部测试使用 `npx vitest run <实际测试文件>`。

Windows 真实 Bash 用例要求 `FIREFLY_TEST_BASH` 指向已核对存在的 Git Bash `bash.exe` 绝对路径。`npm test` 仅扫描 `vitest.config.ts` 列出的目录；`scripts` 下的 `.test.mjs` 不在该集合内，需按 [脚本说明](./scripts/README.md) 单独执行。构建不代替 `check:renderer`，历史测试数字不代表当前工作树通过。

项目归档调用使用 `yauzl@3.4.0` 与 `src/shared/zip-extraction.ts`。旧审计结论保留其阶段意义，不作为当前安全认证。

原生截图助手源码位于 `native/`，manifest 为 `native/Cargo.toml`，构建入口是 `npm run build:screenshot-helper`。此步骤还需要 Rust/Cargo 的 Windows MSVC 工具链；编译出的 `resources/bin/firefly-screenshot.exe` 是本地产物，不进入 Git。Windows 本地打包脚本见 `package.json` 和 `electron-builder.yml`，NSIS 源码为 `build/installer.nsh`。

## 数据与发布

应用用户数据在 `%APPDATA%\Firefly`，包括设置、会话和日志。不要将用户数据、私有语音资源或构建产物复制进源码树。GPT-SoVITS 是用户自行配置的外部服务；自动更新保持关闭。流萤模型与其他素材的公开再分发范围、安装器和更新元数据仍需在发布前核实。

保留现有 Agent Loop、工具权限、审批和任务状态所有者。修改提示词、角色卡或资源时，保留安全与任务执行约束。许可证见 [LICENSE](./LICENSE) 与 [第三方来源说明](./THIRD_PARTY_NOTICES.md)。

## 开发文档

设计文档应明确背景、实现事实、职责边界、变更方案和验收条件。实现状态与验证状态分开：计划、已实现、已自动验证和已实机验收不能互相替代。

源码位置使用仓库相对路径；界面、接口和配置名称与实际实现保持一致。必要日期标明适用阶段，历史计划链接到后续验收记录。文档正文不写个人机器目录、临时分支、执行者协调过程或逐次测试流水；原始日志与交接证据独立保留，不作为架构规范。来源与许可所需的版本和哈希继续保留。
