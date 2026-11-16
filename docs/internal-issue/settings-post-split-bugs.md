# 设置页拆分发现的三项既有缺陷延后至拆分后修复

状态：已决定延后（待设置页拆分 PR 4 完成后在独立修复 PR 中统一处理）
日期：2026-11-16

## 现象

在编制设置页（`src/renderer/settings/`）拆分设计并逐行排查时，发现了三项不影响拆分前既有行为但需修正的小缺陷：

1. **`NAV_LABELS` 语言切换后不刷新**：`src/renderer/settings/shared/section-router.ts` 第 14–31 行在模块顶层就调用 `t(...)` 并写入常量表 `NAV_LABELS`，导致设置窗口在运行期切换中英文语言后，各分区的顶部标题和提示副标题仍保留模块初始化时的旧语言文本。
2. **存在未被引用的死常量 `MIMO_ICON_URL`**：`src/renderer/settings/settings.ts` 第 69 行定义 `const MIMO_ICON_URL = ...`，全文件无任何引用。
3. **`settings.fetchModels` 裸用全局标识符**：`src/renderer/settings/settings.ts` 第 890 行直接调用 `settings.fetchModels?.(...)`，未显式经 `window.settings` 访问，紧耦合依赖隐式全局 `settings` 声明。

## 触发条件或复现步骤

1. **标题不跟随切换**：打开设置页后切换到任意非默认语言，随后点击左侧导航栏切换到其它分区（如 `plugins`、`memory`、`general`），顶部标题与说明取自模块加载期已求值的 `NAV_LABELS`。
2. **代码扫描确认**：检查 `src/renderer/settings/shared/section-router.ts:14-31` 与 `src/renderer/settings/settings.ts:69,890`。

## 影响范围

- **受影响页面**：传统多面板设置窗口（`src/renderer/settings/`）。
- **影响程度**：仅涉及设置窗口顶部标题实时翻译刷新、单条无用常量与全局 `window.settings` 显式属性写法。

## 根因

`docs/design/2026-11-15-settings-page-split.md` 指出，为坚持“结构搬移与 bug 修复严格分离”（确保拆分 PR 可零成本独立回归或按提交回退），排查出的这些既有问题在 PR 2（PR `#87`）中刻意原样搬入 `section-router.ts` 或保留在 `settings.ts`，未混入拆分提交。

## 当前状态

- **已决定延后**：负责人（`hotaru`，2026-11-15）已在 `docs/design/2026-11-15-settings-page-split.md`「负责人决定」第 4 条明确规定：上述三项问题均等设置页拆分全部完成（即 PR 3、PR 4 合并后）再单独提一个修复 PR 统一解决；其中 `MIMO_ICON_URL` 暂不删除，`settings.fetchModels` 暂不改成 `window.settings!.fetchModels`。

## 相关文件

- `docs/design/2026-11-15-settings-page-split.md`（§6 PR 划分、§负责人决定 #4）
- `src/renderer/settings/shared/section-router.ts`（第 14–31 行 `NAV_LABELS`）
- `src/renderer/settings/settings.ts`（第 69 行 `MIMO_ICON_URL`、第 890 行 `settings.fetchModels`）
- 相关拆分 PR：PR `#87`（`5dc1caf`，将 `NAV_LABELS` 从 `settings.ts` 迁入 `section-router.ts`）
