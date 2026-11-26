# Firefly 1.2.0 插件持久化状态文件（`plugin-state.json`）存储格式规范

状态：已定稿（G38 施工前置）
日期：2026-11-23
规格：`docs/superpowers/specs/plugin-sdk-1-2-0.md`（§4、§6.5、§7.1、§8）及 `src/plugins/v2/services/README.md`

## 背景与问题

Firefly 1.2.0 引入独立的 v2 插件进程宿主与权限模型，需要将每个已安装插件的生命周期状态、授权记录、首次使用确认与模型限频持久化到 1.2.0 正式数据目录（`%APPDATA%\Firefly-1.2.0\plugin-state.json`），且不得读取或迁移 1.1.x 的旧目录。在实现持久化存储和组合根装配前，需要先锁定文件位置、路径解析方式、JSON 结构与异常边界。

## 存储位置与边界约束

- **正式路径**：`%APPDATA%\Firefly-1.2.0\plugin-state.json`（开发/测试/冒烟档案落在对应隔离根的 `userData/plugin-state.json`）。
- **路径解析**：通过 `StorageContext.files.pluginState`（`src/main/base/storage/storage-context.ts`）统一派生，禁止在业务模块或插件模块中硬编码 `%APPDATA%` 或新增未经登记的 `app.getPath("userData")` 直接调用（需保持 `pnpm run check:storage-boundary` 通过）。
- **原子写入**：通过 `AtomicJsonStore`（`src/main/base/storage/atomic-json-store.ts`）落盘，使用同目录临时文件 + `flush: true` + `.bak` 单备份 + 原子重命名，写入失败时不得留下半截文件或损坏现有有效数据。

## Schema 定义（`schemaVersion: 1`）

```ts
export interface PluginStateDocumentV1 {
  schemaVersion: 1;
  plugins: Record<string, StoredPluginStateV1>;
}

export interface StoredPluginStateV1 {
  /** 已安装版本号（SemVer，与 manifest.version 一致） */
  version: string;
  /** 主入口相对路径或已校验的入口元数据（与 manifest.main 一致） */
  main: string;
  /** 安装目录（包根路径，可选；未指定时按 <userData>/plugins/<id>/<version> 解析） */
  installDir?: string;
  /** 经校验的 v1 清单元数据快照 */
  manifest: PluginManifestV1;
  /** 是否启用（安装后默认 false） */
  enabled: boolean;
  /** 用户当前授予的权限集合（含 manifest.permissions 子集与已授权工具标识） */
  grantedPermissions: string[];
  /** 授权修订号，正整数，初始为 1；撤销/重授权限、升级版本、停用插件时严格递增，永不复用 */
  revision: number;
  /** C10 首次使用确认记录（仅针对 sessions.read / workspace.read / model.run），值为批准时的 revision */
  confirmations: Partial<Record<"sessions.read" | "workspace.read" | "model.run", number>>;
  /** 模型调用滑窗限频（次/分钟），范围 1..60，默认 10 */
  modelRateLimit: number;
}
```

## 状态变更与容错语义

1. **修订号（`revision`）单调递增**：
   - 权限撤销（`revokePermission`）、权限重新授予（`grantPermission` / `setGrantedPermissions`）、插件升级（`upgrade`）及插件停用（`disable`）时，`revision` 必须递增。
   - `confirmations` 适配器仅当记录中的 `revision` 等于当前 `access.revision` 时视为已确认；任何上述变更后自动失效，强制重新走首次确认对话。
2. **文件缺失**：首次启动无 `plugin-state.json` 时，以 `{ schemaVersion: 1, plugins: {} }` 初始化内存状态，不主动写空文件，等待首次变更时原子创建。
3. **JSON 损坏 / 结构非法**：读取失败时记录告警，内存回退为空状态（`enabled` 均为 `false`，不启动任何插件），同时保留磁盘原文件不被静默覆盖，拒绝后续状态写入直到人工恢复或清理，确保内存与磁盘一致。
4. **写入失败**：`AtomicJsonStore.write` 失败时清理临时文件并保留磁盘上的上一份有效文件，内存状态立即回滚至磁盘快照，不保留未落盘的内存变更。

## 验收与检查

- `pnpm run check:storage-boundary` 通过且 `scripts/verify/storage-direct-access.json` 无需新增白名单。
- 单元测试覆盖缺失、损坏 JSON、写入失败回滚、修订号递增与首次确认跨重启持久化。
