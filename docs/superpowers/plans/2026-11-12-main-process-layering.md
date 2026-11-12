# 主进程分层施工计划

状态：施工中
规格：`docs/design/2026-11-12-main-process-layering.md`

**目标：** `src/main` 按七层组织，每个文件只引用同层和更低的层；每层有自己的 `AGENTS.md`；依赖方向由测试守住。之后的功能开发按“所在层的 AGENTS.md + 该层的施工文件”进行。

**架构：** 目录按层实际挪动（`base / platform / model / tooling / conversation / knowledge / memory / agent / features / app`），`orchestrator` 拆到 `model`、`conversation`、`tooling`、`agent` 四处，`harness` 目录改名为 `agent/loop`。层级表在 `src/main/layers.json`，`src/main/layering.test.ts` 检查全部引用；存量违规记在 `src/main/layering-known-violations.json`，逐类清零。

**不改的东西：** 运行行为、IPC 通道名、数据格式、打包产物的入口（`dist/main/main/index.js`）。挪文件的施工包只改路径；清违规的施工包可以挪文件、下沉类型、把直接调用改成启动时注入，但不改对外行为。

## 现状

- 挪动前（`e945bf4`）：三端类型检查通过；全量测试 1129 个文件、14465 项通过；IPC 235 个通道无重复、无未用、无缺处理方。
- 挪动前 `src/main` 50 个目录中 37 个互相可达；文件级运行时循环 2 个。
- 挪动后（本计划施工包 A–D）：向上引用 102 处，全部记在存量违规清单里，按层对分布：`memory → agent` 17、`platform → model` 11、`memory → features` 10、`tooling → agent` 10、`conversation → agent` 8、`agent → features` 7、`platform → agent` 7、`platform → knowledge` 7、`model → agent` 4、`platform → features` 4、`platform → tooling` 4、`knowledge → memory` 3，其余 10 处。
- 分析脚本和原始数据：`output/audit-1.2.0/`（`deps.cjs`、`layers.cjs`、`move2.cjs`、`rules-layers.json`、`gen-known.cjs`、`gen-agents.py`）。

## 全局约束

- 每个施工包合并前：`npx tsc -p tsconfig.main.json --noEmit`、`tsconfig.preload.json`、`tsconfig.renderer.json` 三个都通过；`npm test` 全量通过（需要 `FIREFLY_TEST_BASH`）；`npm run check:storage-boundary`、`npm run check:plugin-schema` 通过。
- 存量违规清单只能减少。修掉一条就从清单删掉一条（测试会检查清单与代码一致）。
- 清违规时优先级：挪文件 > 下沉类型 > 启动时注入。不为了过测试把层级表放宽。
- 不读取 1.1.x 用户数据；不新增运行时依赖。

## 文件清单

### 新建

- `src/main/layers.json`、`src/main/layering.test.ts`、`src/main/layering-known-violations.json`
- `src/main/<层>/AGENTS.md` 共 10 份
- 清违规过程中新增的契约文件（按施工包列出）

### 修改

- `src/main` 下全部文件的位置与相对引用；`scripts/`、`package.json`、`tsconfig.main.json`、`tsconfig.sim.json`、`vitest.config.ts`、`electron-builder.yml`、`.gitattributes`、README 中的路径
- 根目录 `AGENTS.md`：加“主进程分层”一节

## 施工包

合并顺序：A → B → C → D → E → F → G → H → I → J → K。A–D 一起作为第一个 PR（只挪不改），之后每包一个 PR。

### 施工包 A：挪走放错位置的通用文件（已完成，`f5ba967`）

- [x] A1 `application/ipc-scope` → `ipc/`；`application/window-activation` → `windows/`；`toast/toast-events`、`chat/user-choice`、`orchestrator/ask-card` → `interaction/`；`chat` 下 4 个文本工具 → `orchestrator/text/`；`chat/image-caption` → `orchestrator/`；`chats/ephemeral-conversations` → `storage/`；`startup/bootstrap-config`、`startup/identity-preflight` → `application/`
  - 验证：三端类型检查；相关 95 个测试文件 880 项通过

### 施工包 B：按七层挪动目录并拆分 orchestrator

依赖：A
- [x] B1 用 `move2.cjs` + `rules-layers.json` 挪动 1468 个文件，改写 3559 处相对引用和 285 处路径字符串
- [x] B2 修运行时按 `__dirname` 计算的路径：`features/plugins/host/plugin-runtime.ts`（2 处）、`platform/speech/audio/mpv-binary.ts`、`platform/windows/app-icon.ts`
- [x] B3 修配置与脚本：`tsconfig.sim.json`、`package.json` 的 `sim*` 脚本与 `build:main` 的面板复制、`electron-builder.yml`、`.gitattributes`、`scripts/verify/music-smoke.mjs` 等
- [ ] B4 全量测试通过；`npm run build:main` 后启动开发版，确认主窗口、设置窗口、插件面板、应用图标、内置插件扫描正常
  - 验证：`npm test`；`npm run build:main && npm run build:preload && npm run build:renderer`；真机启动

**验收：** 全量测试数量不少于挪动前（1129 个文件、14465 项）且全部通过；开发版和打包版都能启动并完成一次 Chat、一次 Work 运行。
**回退：** revert 本包的提交（纯路径变化）。

### 施工包 C：依赖方向测试与存量清单

依赖：B
- [x] C1 `src/main/layers.json`：十个层目录及各自允许引用的层
- [x] C2 `src/main/layering.test.ts`
  - 先写的测试：本身就是测试。两条断言：没有清单之外的越层引用；清单里没有已经修掉的条目
  - 验证：`npm test -- src/main/layering.test.ts`
- [x] C3 `src/main/layering-known-violations.json`：当前 102 条

### 施工包 D：各层 AGENTS.md

依赖：B
- [x] D1 十个层目录各一份 `AGENTS.md`（职责、引用规则、模块表、验证命令、施工文件）
- [x] D2 根目录 `AGENTS.md` 加“主进程分层”一节

### 施工包 E：类型下沉（清单约 45 条）

依赖：C
- [ ] E1 运行相关的公共类型从 `agent/loop/types.ts`、`agent/runtime/firefly-agent.ts`、`agent/runtime/types.ts` 中拆出被下层使用的部分，下沉到 `conversation/transcript` 或 `tooling/registry`（按使用方归属）
  - 先写的测试：`layering.test.ts` 清单中对应条目删除后仍通过；被挪类型的现有测试原样通过
  - 验证：`npm test -- src/main/layering.test.ts src/main/conversation src/main/tooling src/main/memory/context`
- [ ] E2 `agent/runtime/prompt-layers.ts`、`agent-runtime-error.ts` 中被 `model/providers` 使用的类型和错误类下沉到 `model`
- [ ] E3 渠道身份与上下文类型（`features/channels/types.ts`、`channel-context.ts`、`adapters/base.ts` 中被 `memory`、`knowledge/relationship`、`agent` 使用的部分）下沉到 `conversation`（或 `src/shared`）
- [ ] E4 `features/chat/agui-bridge.ts`、`features/scheduler/types.ts`、`features/plugins/host/*` 中被 `agent`、`memory`、`platform/browser` 引用的类型下沉

### 施工包 F：文件归属修正（清单约 30 条）

依赖：C
- [ ] F1 `platform/settings` 中的模型档案文件（`model-settings.ts`、`model-catalog.ts`、`model-connection-state.ts`、`agent-model-routing.ts`、`fetch-vendor-models.ts`）→ `model/config`
- [ ] F2 `platform/settings/settings-ipc.ts`、`general-settings-lifecycle.ts`、`settings-facade.ts` 中依赖上层的装配部分 → `features/settings`
- [ ] F3 `tooling/registry/file-write-evidence.ts`（依赖审查与写入归属）→ `agent/tools`；`tooling/registry` 中其余对 `agent` 的引用按 E1 处理
- [ ] F4 `memory/legacy/memory-user-ipc.ts`（依赖 MCP、贴纸设置、工具登记）→ `features`；`platform/protocols`（依赖贴纸）并入 `platform/stickers` 或上移
- [ ] F5 `features/sessions/pending-adjustment.ts`、`chats-store` 中被 `memory`、`platform/windows` 使用的部分：能下沉的下沉，不能的按施工包 G 注入

### 施工包 G：下层直接调用上层改为启动时注入（清单约 20 条）

依赖：E、F
- [ ] G1 `tooling/registry/tool-registry.ts` 不再直接引用 `memory/legacy`、`knowledge/rag`：注册表只暴露登记接口，由 `agent/tools/tool-registration.ts` 或 `app` 在启动时登记
  - 先写的测试：`tooling/registry` 的测试中，注册表在没有登记记忆 / 检索工具时可以独立创建；登记后工具可见且参数校验不变
- [ ] G2 `platform/music/bootstrap.ts`、`features/diagnostics/device-simulation` 的工具登记移到 `agent/tools` 或 `app`
- [ ] G3 `platform/windows` 对会话存储的调用改为由 `app` 传入回调
- [ ] G4 `knowledge` 对 `memory`、`model` 对 `memory` / `knowledge` 的 6 处引用逐条处理

### 施工包 H：记忆内部分层

依赖：E
- [ ] H1 在 `layers.json` 里为 `memory` 增加内部顺序：`core` → `policy / recall / shadow / sources / history` → `context` → `legacy`，测试同时检查
- [ ] H2 `memory/core/repository.ts` 聚合 5 个子库的职责上移到 `memory/context`；`core/main-actor-authority.ts` 对 `sources` 的引用反转
- [ ] H3 清掉 `context` 与其余子库之间的互相引用

### 施工包 I：智能体运行内部整理

依赖：E
- [ ] I1 `agent/runtime` 与 `agent/loop`、`agent/tools` 之间的互相引用：定出 `loop → tools → runtime` 的方向并写进 `layers.json`
- [ ] I2 `agent/loop` 的类型和函数名按 1.2 规格从 Harness* 改为 AgentLoop*（目录已改名）

### 施工包 J：文件级循环

- [ ] J1 `memory/legacy/obsidian-exporter.ts ↔ memory-store.ts`
- [ ] J2 `ChatMessageList.tsx ↔ StreamdownMessageContent.tsx`

### 施工包 K：死代码

- [ ] K1 逐个确认约 17 个只有测试引用的文件（清单见设计文档 §8 和 `output/audit-1.2.0/coupling-audit.md`），确认无用后连同测试删除

## 验收清单（全量）

- [ ] `layering-known-violations.json` 为空，清单机制从测试中删除
- [ ] 全量测试、三端类型检查、存储边界、插件 schema 检查通过
- [ ] 打包版完成：启动、Chat / Work / Code 各一次运行、插件面板、截图、渠道连接、应用更新检查
- [ ] 7 份功能施工计划和 `docs/` 中的旧路径已按 `rules-layers.json` 批量替换

## 回滚方案

- 挪动类施工包（A、B）是纯路径变化，按提交 revert。
- 清违规的施工包各自独立，按包 revert；清单条目随之恢复。

## 待负责人决定

无（目录方案与 harness 目录改名已于 2026-11-12 确认）。
