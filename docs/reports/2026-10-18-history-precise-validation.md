# H 精确失效修补验证报告

日期：2026-10-18。实施与独立审查均使用获授权的 gpt-6-astra / medium。仅本地独立工作树，未推送、创建 PR、合并或部署。

## 版本与范围

- 基线：`a38c34829b5d6265b6f6f03b2d642f584ec05340`，保留之前全部提交与报告。
- 工作树：`E:\Codex\2026-10-17\task\firefly-history-precise`。
- 分支：`codex/history-precise-invalidation-20261018`。
- 实现提交：`9dc082f7662f68e823d6b9896425b72abb3024bc`；产品源码树 `src`：`e69880099c32b2b5c83ae8f206ed8c2bb677b8fb`。
- 验收时 HEAD 尚为基线，但全部新增实现、测试和验收脚本已暂存。以运行前后文件哈希、随后提交的 Git blob/tree 绑定准确内容，不能只按旧 HEAD 判断验收版本。最终报告提交仅变更文档，保留上述产品源码树。

## 根因与实现

原生 H 的 `sourceDeps` 为空。旧逻辑把任一事实修订或 forget generation 当成同 scope 全部不可追溯历史的永久禁读条件；未来新历史也被阻挡。单纯取消检查会让被纠正或遗忘的原文回流，因此改成精确来源凭据。

schema v12 新增加密 `history_origins` 元数据表，身份绑定 scope、actor、provider、session、canonical event digest、seq、turn/revision。用户凭据只能从可信 direct-user source 的身份、版本、内容指纹和实际 canonical entry 登记。助手/工具凭据来自真正已 claimed 的 context snapshot，冻结实际发送的 M/H/S/current transcript 依赖；不接受模型或 parser 自报依赖，不凭相似文本或时间推测。

每次 H 查询及最终 context materialization 在 Worker 事务内验证来源、tombstone、纠错根、事件撤销和依赖闭包。canonical 删除/repair/rewind 在修改前持久撤销事件；H remove 撤销精确 native 事件，并通过文档身份依赖阻断派生回声。普通 append 不撤销既有独立事件。闭包有 memo、深度 64、累计 1000 项预算，超限保守拒绝。

native 只恢复凭据完整且仍有效的原子组；旧缓存也必须通过相同凭据检查。被隔离的部分保留 coverage-insufficient 通知，不能向模型声称历史不存在。未改变第四阶段检索策略。

真实 Electron 还发现普通 Chat 成功结束后没有 canonical snapshot，导致小会话重启后 H 为 SNAPSHOT_MISSING。经明确授权，在原 Chat 写者成功 output/settlement 后、RUN_FINISHED 前复用原 store.checkpoint。失败明确传播，JSONL 和已落盘 settlement 保留；H 读取器仍只读，Work/Code 路径未扩大。

## 三类实际闭环证据

| 目标 | 经过的路径与断言 | 证据 |
| --- | --- | --- |
| 更正后旧错误不回来 | 真实设置 UI 更正历史事实，随后新会话 H 查询→context 组装→fake transport；请求不含被纠正的旧原文。单元回归另覆盖 before-query、after-query、after-permit 竞态，最后两种必须拒绝发送。 | Electron `incorrect-old-revision-never-recalled-as-history`；`phase3-review-regressions.test.ts` |
| 遗忘后原文、索引、缓存及派生不复活 | forget 同步隐藏所有相应事实期间；第二次冷启动后模型请求不含遗忘的旧原文。旧 unknown native 在 generation 0 也不能进入缓存；source pending/delete、H remove、rewind、闭包根撤销使历史及跨会话派生无效，旧 evidence 在最终 claim 拒绝。 | Electron `forget-synchronously-hides-all-periods`、`second-cold-reopen-no-revival`；native provider、history-origins、main-history、response-history-union 回归 |
| 无关及后续有效历史可用 | 两个在纠正前创建的独立会话，纠正后仍进入新的请求；遗忘后新建有效 Chat，关闭并重启，再次请求同时包含这两个旧独立历史和新历史。最终脚本没有人工 checkpoint。 | Electron `two-pre-correction-independent-histories-reach-wire`、`cold-reopen-old-independent-and-new-history-reach-wire`；Main 默认生产链 synthetic fake-wire 回归 |

正常偏好随时间变化另有实际请求断言 `normal-temporal-change-retains-original-histories`：两个不重叠期间事实及原始历史同时保留，只有明确纠错撤回旧错误根。跨项目测试断言 project 会话只见同项目和 unbound 历史、unbound 会话不见项目历史；actor/provider/session 伪造和 pending union 测试保留。真实 channel read-lease 路径在有限测试超时内完成，覆盖之前递归取锁死锁。

## 最终验证

所有命令都通过 `.verification/run-isolated.cjs` 设置独立 USERPROFILE、APPDATA、LOCALAPPDATA、TEMP、离线包缓存和合成测试身份，不读取真实 key。Electron 使用 `memory-qa.invalid` 的 fake fetch，阻断实际网络并抑制外部后台服务。只复用基线现有 node_modules 与原生 helper；没有 SDK 安装、EXE 构建/打包或付费调用。

| 命令（省略统一隔离 wrapper） | 结果 | 归档 |
| --- | --- | --- |
| `node_modules/typescript/bin/tsc -p tsconfig.main.json`、preload tsc、Vite build | 通过；随后 checkpoint 修改后的 main tsc 再通过。Vite 有既有 chunk-size 提示。 | `build-review-final-1792297562505-b7078d2f`；`checkpoint-build-1792297880377-ce2c80b2` |
| `vitest run ...main-s-stream.test.ts` | 79 通过；真实 Agent snapshot、pending checkpoint、故障保留记录均覆盖 | `checkpoint-green-1792297875753-58bc10a8` |
| `vitest run ...response-history-union.test.ts` | 29 通过，未删除 union/伪造/并发断言 | `union-proof-1792298058776-a6910577` |
| `vitest run ...phase3-review-regressions.test.ts ...smh-integration.test.ts ...native-history-presence-process.test.ts --maxWorkers=1` | 43 通过 | `compatibility-green-1792298228646-12ad3ce1` |
| `scripts/testing/run-tests.mjs` | 883 files / 10854 cases 通过，1 file / 11 cases 既有条件跳过，0 失败；951.97 秒 | `mini-full-1792299413069-93da4c0f` |
| `scripts/verify/history-precise-electron.cjs` | 35 checks / 3 launches 通过，0 失败；无人工 checkpoint | `electron-h-frozen-1792298300769-e0bfcbb7`；详细目录 `electron-history-precise-1792298301512-a9403593` |
| `git diff --cached --check` | 通过 | 提交前检查 |

全量和最终 Electron 的 before/after manifest 均为 2909 个文件，SHA-256 `e44b50ce2e8f84e2a553270d1c4a79bc612a73515b0866dfe6f22c89fe1737bb`（以各 run.json 最终结果为准）。`.verification/final-source-binding.json` 保存运行文件哈希与实现提交 Git blob 的对照。新增产品文件均包含在内，验证输出不属于产品 manifest。

Electron 的 `model-requests.ndjson` 是实际发送给 fake transport 的请求记录；`result.json` 是逐项断言；三张截图保留 UI 证据。截图可见来源标签存在既有 i18n object 文案提示，本修补未修改相关 UI/locale 文件，未把该显示问题计为 H 语义通过的依据。

## 失败、停止运行与修复过程

- 初始 origins/closure/native recovery/producer/revocation RED 在 `.verification/runs` 分别保留；不是最终通过结果。
- `memory-targeted-1792296699904-90b1826a` 因真实 channel 重入 read lease 死锁诊断主动停止。修复为 producer 先取可信 evidence，canonical lease 内登记只执行 Worker I/O；真实 channel 回归及全量复验。
- 独立审查还发现 S 缺凭据、投影预算硬失败、summary 和 H excerpt 引入未发送依赖、两个独立时钟错误比较、H 删除后派生未失效；均修复并复审。完整发现及处理在独立审查报告，不能简化成首次即通过。
- `memory-final-1792297651217-69ac7407` 是失败运行：112 files / 2434 cases 通过，4 files / 38 cases 失败，另 1 file / 5 cases 跳过。27 union（该文件共 29 项，其中 2 项当时已通过）+ 5 phase3 + 1 SMH 涉及旧原始 native fixture 与新来源要求；分别补精确 user 登记、加强 unknown assistant 立即拒绝、验证无关历史恢复。另 5 presence helper 失败是新工作树缺 debug helper；复用基线既有构件后 15 项该文件测试通过。没有统一授予未知 assistant 凭据或删安全断言。
- `mini-full-1792297975810-0bde7e99` 因上述 fixture 问题停止；`mini-full-1792298256979-eeaeba42` 在预检发现 EOF 空行后立即停止并清理格式。两轮都未完成，不计通过。
- `mini-full-1792298276485-5cb163ed` 完整执行但失败：882 files / 10853 cases 通过、1 file / 1 case 失败、1 file / 11 cases 跳过。唯一失败为扩展的连续记忆故事超过原 30 秒限制（32,755 ms）；该文件运行时与 Electron 重叠。源码未变，单独复现 `story-timeout-check-1792299357242-8625a298` 在 22,157 ms 通过全部故事断言（其余 125 为 `-t` 筛选，不计产品跳过）；此前定向故事为 19,362 ms。证据支持并发资源竞争，但不宣称证明全部耗时差异原因。未提高 timeout、删除断言或调整 skip；随后串行重跑上表最终完整全量；相同故事 19,386 ms 通过，默认记忆文件 126 项在 72,821 ms 内全部通过。
- 首次 `electron-h-1792297646585-6a26521f` 在第 15 项失败，实际原因是正常 Chat 缺 snapshot。`electron-h-checkpoint-1792297749762-bbd20a7a` 人工调用 checkpoint 的 35 项仅用于定位，不是最终生命周期验收。加入正常写者 checkpoint 后，无人工 checkpoint 的 `electron-h-production-1792297927387-9eff5f82` 35 项通过，再以冻结 manifest 运行上表最终 Electron。
- 初次 build 的编译阶段通过，随后复制缺少的本地资源失败；改为复用基线既有 plugin-marketplace 静态构件后 build-review-final 完成，未运行被禁止的 marketplace/SDK 构建。
- 独立 reviewer 自行启动测试一次，因 sandbox reporter 临时文件 rename EPERM 在用例执行前退出，未声称测试通过，未重试或绕过；其最终结论是只读代码复审通过。测试结果由本报告实际命令提供。

## 恢复限制与回退

升级前完全无凭据的 user/assistant/tool 不会自动恢复，也不能靠用户点击、相似文本、重建 snapshot 或旧 ledger 中的 messageId 升格为 live 来源。本次没有自动旧数据重建器。真正 source-bound canonical H 沿用其可信来源验证；新受控 producer 形成的独立有效历史可恢复。附件或不能完整证明的上下文、超闭包预算、缺少 snapshot/helper 的部分继续保守隔离并报告覆盖不足。

v11→v12 迁移在事务中创建独立表；测试证明中断回滚、旧 fact 密文不被改写且升级后可读。旧应用拒绝 v12；`git revert` 不能回退数据库。若需要应用降级，须恢复完整升级前备份，或另行实现并验证官方 down migration；不能直接删凭据表冒充安全回退。恢复备份会失去备份后写入，应单独评估，不能在真实库上试验。

实现及测试均已保存在本地分支，原基线与其他工作树未改。原 phase3 工作树只读 `git status --short` 为空，HEAD 仍为基线。`.verification/` 留作本地证据，不提交合成运行数据。

进程只读审计见 `.verification/process-audit.json`：05:13:49 UTC 最终核对，11 个在本任务 Electron result 中记录的 PID 均不存活，先前全量 Vitest PID 30528 已退出，本工作树路径匹配的 node/electron 进程为空。停止的 runner 工具会话均已返回退出，但没有分别保留其完整孙进程 PID 集合，因此不作“所有未知孙进程均已逐一确认退出”的笼统保证。没有扫杀用户实例。

未解决的 H 修补阻塞：无；候选卡片的独立 UI/策略问题不属于本修补，父任务另行处理。。
