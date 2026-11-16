# 插件示例存在停止写回被清空及非 JSON 对象持久化缺陷，Mock 测试无法检出

状态：待修复（已登记于 `examples/README.md`，留待后续处理）

## 现象

仓库 `examples/` 中的示例插件经 `examples/README.md`「当前源码限制」核查发现多处真实宿主运行缺陷，而 `npm run test:plugin-examples` 使用 `@firefly_wu/plugin-sdk/testing` 的 `createMockPluginContext` 进行注册冒烟时不会报错或失败：

1. **停用时先清空内存变量再写回存储，导致持久化写空**：
   - `examples/weather-tool/index.ts` 在 `unregister()` 先将 `recentCity` 置空，随后 `ctx.dispose()` 才调用 `onDispose()` 尝试保存 `lastCity`；
   - `examples/long-term-memory/index.ts` 在 `unregister()` 于保存回调前清空记忆；
   - `examples/scheduled-automation/index.ts` 在 `unregister()` 先清空 `ownedIds`，随后 `onDispose()` 向存储写入空数组，导致重启后无法恢复任务所有权清单。
2. **向 JSON 存储直接写入 `Map` 对象**：`examples/long-term-memory/index.ts` 将 `Map` 实例写入 `ctx.storage`，真实宿主经 `JSON.stringify`/`JSON.parse` 恢复后失去 `Map` 方法（变成普通对象）。
3. **消息读取与事件边界处理不完整**：`examples/long-term-memory/index.ts` 读取会话消息只取一页未循环消费游标，且在 `host:turn:finished` 事件没有 `finalMessageId` 时未跳过。
4. **`examples/system-status/index.cjs` 未传盘符固定查 `C` 盘**，而非动态发现系统盘或枚举全部磁盘；CPU/网络差分首次缺少基准。

## 触发条件或复现步骤

1. 在真实 Firefly 宿主中启用 `weather-tool`、`long-term-memory` 或 `scheduled-automation`，执行查询、产生摘要或创建定时任务。
2. 停用或卸载重启后再次启用，查看 `<userData>/plugin-data/<pluginId>/` 落盘内容，发现缓存丢失或反序列化结构异常。
3. 执行 `npm run test:plugin-examples`（调用 `scripts/plugin-sdk/smoke-examples.mjs`），仍全部通过。

## 影响范围

- **受影响示例**：`examples/weather-tool/`、`examples/long-term-memory/`、`examples/scheduled-automation/`、`examples/system-status/`。
- **开发者误导风险**：若插件作者直接复制示例里的 `unregister()` + `onDispose()` 写法或依赖 `Map` 持久化，并用 `MockPluginContext` 作为唯一验证，会把相同缺陷带入第三方插件。

## 根因

1. `src/plugins/manager.ts` 的停止流程顺序固定为：`beginStop()` → 插件 `unregister()` → `ctx.dispose()`（按逆序触发 `onDispose` 回调），而上述三个示例错误地在 `unregister()` 提前清理了仍需由 `onDispose()` 写盘的模块状态。
2. 真实存储 `src/plugins/storage.ts` 通过 `JSON.stringify` / `JSON.parse` 序列化落盘（`Map` 会序列化为空对象 `{}`），而 `plugin-sdk/src/testing/index.ts` 的 `createMockPluginContext` 使用内存 `Map` 原样保存引用且 `dispose()` 不代调 `unregister()`，因此冒烟测试掩盖了这两类 bug。

## 当前状态

- **待修复**：`examples/README.md` 已把上述源码限制与 Mock 盲区完整登记为已知缺陷，留待后续修复；目前已在 [plugin-dev-guide.md](../plugins/plugin-dev-guide.md) 与 [plugin-authoring.md](../plugins/plugin-authoring.md) 中向插件作者做出明确警示。

## 相关文件

- `examples/README.md`（当前源码限制）
- `examples/weather-tool/index.ts`
- `examples/long-term-memory/index.ts`
- `examples/scheduled-automation/index.ts`
- `examples/system-status/index.cjs`
- `plugin-sdk/src/testing/index.ts`
- `src/plugins/storage.ts`、`src/plugins/manager.ts`
