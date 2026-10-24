# 设备模拟整合头：独立等价核对

日期：2026-10-18。**已独立核实整合头与已审实现等价。原最终 I1/I2/M1/M2 均已闭合、0 Critical / 0 Important / 0 Minor 的结论适用于 `54bee93`。最终整合版本全量仍待执行。**

本次仅按授权核实固定 Git 对象、提交对应关系和 PR 增量范围，没有重开代码审查、等价研究或测试，也没有修改产品工作树、index、HEAD、分支、配置或依赖；没有派发 agent。

## 固定对象

| 项目 | 提交 |
| --- | --- |
| 原已审最终头 | `e0ed0fac57dd0bdeee2a272e99637e221d453e9f` |
| 新目标基线 | `271f1dd5baf4a24939fdfe9c2c5d91d718cade11` |
| 独立设备整合头 | `54bee93793efab7be72acdc8c568fd496b741643` |
| 原八提交区间的基线 | `eac3e67c1d7d1f2b7a842a31c4f3d3420ef79f77` |

检查时实际 HEAD 为 `54bee93`，工作树干净。已通过 `git merge-base --is-ancestor` 核实新目标基线是整合头祖先，`git rev-list --count` 得到该区间恰好 8 个提交。

## 独立核实的有限事实

读取 [integration-evidence.json](integration-evidence.json) 后，本席重新执行固定引用上的 `git rev-parse <commit>:<file>`，没有仅采信其中的布尔值：

- **10/10 源码与测试 canonical Git blob 完全相同**，实际对象 ID 也逐项等于该 evidence 的记录：device-simulation 的 contracts/controller/journal/mcp-fixture 四个模块及四个测试，加 mcp-adapter 与 lifecycle 测试。
- **8/8 依赖条目 canonical Git blob 完全相同**：6 个宿主文件 `atomic-json-store.ts`、`runtime-profile.ts`、`storage-context.ts`、`tool-registry.ts`、`permission-policy.ts`、`abort-utils.ts`，以及 `package.json`、`package-lock.json`。这里是 8 项合计。
- 新目标基线到整合头的 `git diff --name-only` 与 evidence 的列表逐项相同：**16 文件，只有 6 项设备文档、8 项设备模块/测试、2 项 adapter/lifecycle 文件**。该 PR 增量没有外部技能市场批次变更。
- 原八提交区间与新八提交区间的实际 `git range-diff --no-color` **8/8 均为 `=`**，没有遗漏、增加或改变补丁的提交。

实际 range-diff 对应关系：

| 原提交 | 整合提交 | 结果 |
| --- | --- | --- |
| `543a27f` | `0455580` | `=`：模拟计划 |
| `d9f5ce2` | `f2f7b55` | `=`：契约与 journal |
| `5801d85` | `5b96510` | `=`：授权及命令生命周期 |
| `1317bf3` | `c024431` | `=`：真实 owned MCP fixture |
| `0a5fe23` | `4989fad` | `=`：I1/I2 原修复 |
| `1e587d1` | `f9d7bd6` | `=`：原验证文档 |
| `09a0651` | `de25cbf` | `=`：M1 归属清理 |
| `e0ed0fa` | `54bee93` | `=`：I2 缺失日志与 M2 重试 |

工作树 CRLF 可能随 checkout 归一化；本次判断依据为固定 Git blob 身份与补丁等价，没有把工作文件换行差异当作实现变化。以上对象核对没有产生新的运行时行为证明，也没有重复运行既有通过的套件。

## 原结论与证据保留

[原最终报告](independent-review.md) 的 I1/I2/M1/M2 闭合结论及其模拟、异步回执、撤权、日志/lease 边界继续适用。原 scoped GREEN 为 158 项，最终差异及 10 文件哈希映射详见该报告；本说明不将这组旧基线运行冒称为整合头的最终全量。

原报告内容保持不变，已重新读取并计算 SHA256：

| 报告 | SHA256 |
| --- | --- |
| `independent-review-initial.md` | `dae45fc4fd3b17e217d51ced73a1ed695d1c852ee0dec28cbe70e33b4417b7e3` |
| `independent-review.md` | `4f7b111a6ba95bc04533af7966d021eda3deec59e44271119a9d5546e5138113` |

## 限制与处置

- 新目标的 UI/设置变更没有在本次重新代码审查；本席只判断上述实现与基础依赖等价，以及 PR 增量的设备范围。
- 仍沿用全部原模拟范围裁定；本次等价迁移未提供真实设备、账户、GUI 控制、厂商回执、OS crash recovery 或跨进程 exactly-once 的新结论。
- 未运行测试、类型检查或全量；最终 clean 整合头全量由执行器后续运行一次，并据真实结果归档。

**等价核对通过，无待解决的核对阻塞。原最终闭合结论适用于 `54bee93`；最终全量仍待执行。** 原 initial/final 报告和既有证据均保留。
