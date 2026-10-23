# 设备模拟批次：有界质量收尾与独立复审

最终结论：**0 Critical / 0 Important / 0 Minor，I1、I2、M1、M2 均闭合。** 实际最终测试代码为 `54bee93793efab7be72acdc8c568fd496b741643`，独立目标基线为 `271f1dd5baf4a24939fdfe9c2c5d91d718cade11`。本次 QA 提交只增加记录，不改变此代码。历史原始审查和验证均保留，本文覆盖旧记录中 M1 延后的当前状态。

## 范围与根因

- 模拟范围仍限灯、空调、窗帘固定 fixture，以及 Main 内的显式可信宿主接线。opaque grant、逐操作确认、异步接受/回执关联、撤权、持久 pending/terminal、日志与 lease 边界保留；未注册到普通启动路径，没有实际厂商协议、凭据、UI 或真实设备接入。
- M1：原 wrapper 为避免误删替换工具，会跳过整个 adapter disconnect，从而遗留 client/transport。现在 adapter 记录每个已注册 ToolDefinition 的引用，清理时仅删除仍由它拥有的同一对象，并总是尝试关闭自己拥有的连接。Main 私有 owner 身份隔离同名 server 的当前/旧 client 和并发连接，避免误删别人的新工具或关闭新连接。owner 不从 MCP/持久配置传入，也不构成授权。
- 原 Important I1/I2：保留迟到 accepted 不覆盖 terminal、损坏 journal/失效 lease 失败即拒绝继续的修复。
- 本轮独立复审复现了额外 I2 缺失日志变体：已物化 primary 消失后旧 fallback 可能重建空日志并继续 receipt。journal 现在记住物化状态，primary 缺失或只有 backup 时拒绝继续；fresh 无 primary/backup 的初始化仍允许。健康失败只返回 transient unknown，原 cached accepted 保留，receipt 不执行。
- 本轮 M2：第一次 close 的资源关闭错误不再永久缓存失败 promise，显式重试可继续释放本适配器资源；成功关闭仍幂等，并发关闭合并，不重放设备命令。

## TDD 与实际验证

| 验证 | 实际结果 |
| --- | --- |
| M1 回归 RED | 5 失败 / 35 通过，未处理异常 0 |
| 独立复审追加修复 RED | 6 失败 / 53 通过（I2 缺失日志 5 + M2 1），未处理异常 0 |
| 最终相关 GREEN | 158 通过 / 8 文件，含设备 90 与 adapter lifecycle 29；无跳过、失败、未处理异常 |
| 最新独立代码全量 | 10779 通过 / 11 跳过 / 0 失败 / 未处理异常 0，877 文件 |
| 最新整合 Main 类型 | exit 0 |
| 存储边界 | PASS，88 处访问 / 46 文件（既有相关检查） |

全量实际开始 2026-10-18T06:28:57.317Z，结束 2026-10-18T06:43:58.009Z；开始和结束均为同一干净代码头，10 个源/测试文件 SHA256 核对不变，11 个新增回归均在全量中通过，跳过项与原全量完全相同。归档 SHA256：`95379f438e5d3f8a564307a3d0c333f5fc301042671a023aabdc23b39b7df601`。M1 阶段另有两组互不重叠的 248 + 168 = 416 通过，仅作为阶段性证据，不与最终 158 累加或冒充同一版本。

一次新增测试错误期待健康失败后仍直接返回 accepted；既有 controller 的契约是 transient unknown、内部 cached accepted 保留。该断言修正并加强后，先恢复本任务拥有的旧 journal，再观察到全部 6 个目标 RED，之后应用最终修复获得 GREEN。未把失败尝试报告为通过，未放宽生产断言、测试门槛或超时。

## 独立复审与整合等价

同一独立审查员（gpt-6.1-sol / max）先复现问题，再增量核对修复与真实 RED/GREEN、最终差异、10 文件摘要；最终结论 0/0/0，I1/I2/M1/M2 闭合。审查员随后单独核对迁移到最新独立分支：10 个源/测试 Git blob、8 个基础依赖/包文件完全相同，8 个重放提交 range-diff 全为等号，原独立 PR 16 文件仅设备模块、adapter 与设备文档，未混入外部技能批次。整合等价审查没有重复运行测试；全量由本任务实际执行。

- [初次独立复审](2026-10-18-device-simulation-closure/independent-review-initial.md) 保留 1 Important / 1 Minor 的历史发现。
- [修复后最终复审](2026-10-18-device-simulation-closure/independent-review.md)。
- [最新独立代码等价复核](2026-10-18-device-simulation-closure/independent-review-integration.md)。
- [完整 verification JSON](2026-10-18-device-simulation-closure/verification-final.json) 与 [整合对象证据](2026-10-18-device-simulation-closure/integration-evidence.json)。

## 保留的限制

这是隔离的模拟连接器验证批次，不能据此宣称真实设备已接入。没有运行普通 app/GUI、账户/凭据、真实网络设备、付费模型、下载/安装或本地 SDK/EXE 打包；没有改变已有 CI、授权策略或模拟范围。OS crash recovery、跨进程 exactly-once、加密 journal 证明及对抗性同进程篡改不在本次保证内。仅提交独立 PR，既有远端 CI 单列记录，不合并、不部署、不进入下一阶段。
