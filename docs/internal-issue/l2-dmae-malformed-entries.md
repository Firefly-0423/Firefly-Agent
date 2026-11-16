# 旧版 `memory.json` 中 `l2DmaeStates` 含坏条目时按 ID 查找与更新会抛错

状态：已决定延后（读取规范化已在 PR #71 修复；`getL2DmaeState` 与 `updateL2DmaeState` 坏条目抛错延后统一清理）
日期：2026-11-16

## 现象

当持久化文件 `memory.json` 的 `l2DmaeStates` 数组中混入 `null` 或非对象条目时：

1. 在 PR `#71` 修复之前，加载记忆库时的状态名大小写规范化直接访问 `entry.state`，会导致整个记忆库读取失败。
2. 目前在 PR `#71` 之后，读取与写回 L2 正文已不再崩溃；但调用 `memoryStore.getL2DmaeState(l2Id)` 或 `memoryStore.updateL2DmaeState(l2Id, patch)`（以及内部依赖它的 `l2DmaeManager.syncToStore`）遍历 `doc.l2DmaeStates` 时仍直接读取 `s.l2Id`，遇到 `null` 条目会抛出 `TypeError`；同时 `l2DmaeManager.loadStates()` 亦未过滤非对象元素。

## 触发条件或复现步骤

1. 在用户目录 `memory.json` 的 `l2DmaeStates` 数组中存在 `null` 等非对象元素（同时 `isCurrentMemoryStore` 仅校验 `l2DmaeStates` 为 `undefined` 或数组，不校验元素形状）。
2. 加载并触发查询或更新单个 L2 激活状态：`memoryStore.getL2DmaeState(l2Id)` / `memoryStore.updateL2DmaeState(l2Id, patch)` / `initL2DmaeStateIfMissing(l2Id)` / `l2DmaeManager.loadStates()`。
3. 执行 `(doc.l2DmaeStates ?? []).find((s) => s.l2Id === l2Id)` 时因 `s` 为 `null` 抛出 `TypeError: Cannot read properties of null (reading 'l2Id')`。

## 影响范围

- **受影响组件**：早期记忆库（`src/main/memory/legacy/`）中启用 V5 L2 DMAE 状态追踪的读写与同步路径。
- **已缓解边界**：单纯加载记忆库、规范化旧大小写状态名（`"Active"`/`"Dormant"`/`"Archived"`）以及读取 L2 正文不会再因单个坏条目而失败（PR `#71` 已补测试覆盖）。

## 根因

1. `src/main/memory/legacy/memory-store-defaults.ts` 的 `isCurrentMemoryStore`（第 53–54 行）只检查 `l2DmaeStates` 是否为数组，未检查每个数组项是否为合法对象。
2. `src/main/memory/legacy/memory-store.ts`（第 561–579 行）在 `getL2DmaeState` 和 `updateL2DmaeState` 中直接对数组项解引用 `s.l2Id`；`src/main/memory/legacy/l2-dmae-manager.ts`（第 103–106、171–174 行）在 `loadStates` 与 `syncToStore` 中也直接读写 `s.l2Id` / `stored.l2Id`。
3. 2026-11-15 PR `#71` 代码审查发现该关联隐患，因 `fix/dmae-state-case` 仅限大小写映射与加载容错，未顺带改造查找与清理逻辑。

## 当前状态

- **读取兼容（已修复）**：PR `#71`（`89d705c`）已在 `normalizeL2DmaeStateNames` 中增加 `!isPlainObject(entry)` 保护，只转换三个已知旧名，其他条目原样保留。
- **坏条目抛错与清理（已决定延后）**：`docs/superpowers/plans/2026-11-15-coupling-audit-followup-progress.md` §4 记录负责人 2026-11-15 决定，此类坏条目留待后续统一清理，当前不改。

## 相关文件

- `docs/superpowers/plans/2026-11-15-coupling-audit-followup-progress.md`（§4 偏离计划）
- `src/main/memory/legacy/memory-store-defaults.ts`（`normalizeL2DmaeStateNames`、`isCurrentMemoryStore`）
- `src/main/memory/legacy/memory-store.ts`（`getL2DmaeState`、`updateL2DmaeState`）
- `src/main/memory/legacy/l2-dmae-manager.ts`（`loadStates`、`syncToStore`）
- `src/main/memory/legacy/memory-store-dmae.test.ts`
- 提交与 PR：PR `#71`（`89d705c`）
