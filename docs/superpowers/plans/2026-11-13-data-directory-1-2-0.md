# 1.2.0 正式数据目录施工计划

状态：施工中
规格：负责人 2026-11-12 决定——1.2.0 正式数据目录为 `%APPDATA%\Firefly-1.2.0`，不读取、不迁移 1.1.x 的数据。

**目标：** 正式安装版的设置、会话、记忆、日志和插件数据全部放在 `%APPDATA%\Firefly-1.2.0`。1.1.x 留下的 `%APPDATA%\Firefly` 原样保留，1.2.0 不读也不写它。

**架构：** 数据目录名由 `src/main/base/identity/runtime-profile.ts` 的一个常量决定；安装器写开机自启选项时用同一个目录名，由打包配置测试守住两边一致。目录名按 1.2 这一代固定为 `Firefly-1.2.0`，不随补丁版本号变化（1.2.1 仍用同一目录），避免每次补丁都丢数据。

**不改的东西：**
- 开发 / 测试 / 冒烟档案的目录（`<隔离根>/Firefly-<档案名>`）不变。
- 应用名（`app.setName("Firefly")`）、托盘文字、通知名不变。
- 不新增任何读取或迁移 `%APPDATA%\Firefly` 的代码。

## 现状

- 正式档案的数据目录写死在 `resolveRuntimeProfile`：`path.join(input.productionAppData, "Firefly")`（`src/main/base/identity/runtime-profile.ts`）；`userData`、`sessionData`、`logs` 都由它派生。
- 安装器把开机自启选项写到 `$APPDATA\Firefly\installer-options.json`（`build/installer.nsh` 的 `customInstall`）；应用在 `settings-facade.ts` 里从设置文件旁边读它。打包配置测试 `scripts/packaging/electron-builder-config.test.mjs` 断言了这个路径。
- `src/main/base/identity/app-identity.ts` 的 `FIREFLY_USER_DATA_DIRECTORY` / `configureFireflyApplicationIdentity` 只被自己的测试引用，生产启动走 `runtime-profile.ts`。
- README、README.en、DEVELOPMENT 写着数据在 `%APPDATA%\Firefly`。
- `scripts/verify/memory-online-startup` 的两个脚本按 `%APPDATA%\Firefly` 找模型设置。

## 全局约束

- 测试按 `AGENTS.md` 的断言写法；先改测试看到失败，再改实现。
- 不读取、不迁移 1.1.x 数据；不删除 `%APPDATA%\Firefly`。

## 文件清单

### 新建
- `src/main/base/identity/data-directory.ts`：目录名常量与正式目录路径函数。
- 本计划的进度文档。

### 修改
- `src/main/base/identity/runtime-profile.ts`、`runtime-profile.test.ts`
- `src/main/base/identity/app-identity.ts`、`app-identity.test.ts`（常量改为引用新模块）
- `src/main/app/identity-preflight.test.ts`
- `build/installer.nsh`、`scripts/packaging/electron-builder-config.test.mjs`
- `scripts/verify/memory-online-startup/drive.mjs`、`entry.cjs`
- `README.md`、`README.en.md`、`DEVELOPMENT.md`

## 施工包

只有一个施工包（一个 PR）。

### 施工包 A：数据目录改为 Firefly-1.2.0

依赖：无
**改动文件：** 见上方文件清单（非测试文件 8 个）。

**任务：**

- [x] A1 目录名常量
  - 先写的测试：`src/main/base/identity/runtime-profile.test.ts`：正式档案 → `userData` 为 `<appData>/Firefly-1.2.0`，`sessionData` 相同，`logs` 为 `<appData>/Firefly-1.2.0/logs`；返回的任何路径都不等于也不在 `<appData>/Firefly` 之内。开发档案 → 仍为 `<隔离根>/Firefly-development`。
  - 实现：新增 `data-directory.ts` 导出 `FIREFLY_DATA_DIRECTORY = "Firefly-1.2.0"`；`resolveRuntimeProfile` 的正式分支用它；`app-identity.ts` 的 `FIREFLY_USER_DATA_DIRECTORY` 改为引用同一常量。
  - 验证：`npm test -- src/main/base/identity src/main/app/identity-preflight.test.ts`
- [x] A2 安装器写到同一目录
  - 先写的测试：`scripts/packaging/electron-builder-config.test.mjs`：安装器脚本写 `$APPDATA\Firefly-1.2.0\installer-options.json`；不再出现 `$APPDATA\Firefly\installer-options.json`；目录名与 `data-directory.ts` 的常量一致（测试读取常量源码比对，避免两处各写一份后漂移）。
  - 实现：`build/installer.nsh` 的 `CreateDirectory` 与 `FileOpen` 改用 `Firefly-1.2.0`。
  - 验证：`node --test scripts/packaging/electron-builder-config.test.mjs`
- [x] A3 验证脚本与文档
  - 先写的测试：无（脚本与文档）。
  - 实现：`memory-online-startup` 的两个脚本改用新目录名；README、README.en、DEVELOPMENT 的数据位置改为 `%APPDATA%\Firefly-1.2.0`，并说明 1.1.x 的 `%APPDATA%\Firefly` 不会被读取或删除，需要时可自行备份或清理。
  - 验证：`git grep` 确认除历史文档外不再把 `%APPDATA%\Firefly` 当作当前数据目录。

**验收：** 三端类型检查、相关测试、打包配置测试、全量测试通过；`npm run build` 通过；开发版启动不受影响。打包版安装后数据出现在 `%APPDATA%\Firefly-1.2.0`，`%APPDATA%\Firefly` 未被触碰（真机验证在下一次打包时做）。

**回退：** revert 本包提交即可回到 `%APPDATA%\Firefly`。

## 验收清单（全量）

- [ ] 施工包 A 合并，验收通过
- [ ] 打包版真机验证：全新安装后数据在 `%APPDATA%\Firefly-1.2.0`；已有 `%APPDATA%\Firefly` 的机器上，旧目录内容不变；勾选“开机自启”后首次启动读到该选项

## 回滚方案

revert 施工包 A。1.2.0 写入 `Firefly-1.2.0` 的数据不会影响 `Firefly`。

## 待负责人决定

无（目录名与“不迁移”已由负责人 hotaru 于 2026-11-12 决定）。
