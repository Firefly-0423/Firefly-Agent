# 记忆候选面板修复验证（2026-10-18）

## 交付与基线

- 产品提交：`5f9168d68c0565976d0feaa8e2c5dd3e93ad43cb`。
- 父提交：H 产品 `9dc082f7662f68e823d6b9896425b72abb3024bc`。
- 独立工作树：`E:\Codex\2026-10-17\task\firefly-candidate-panel`。
- 分支：`codex/candidate-panel-20261018`。
- H 后续纯文档提交 `aa7d3bfa03bea7b2dfc6924dcd05747932d38122` 留在 H 工作树，没有合并或 cherry-pick。本报告在产品验证后单独提交。

## 根因与最小修复

普通任务文本可能被保守提取器记录为仅含来源与原因的内部参考。它们不复制任意未知/敏感正文，因此 assertion 为空是安全设计，并不是 IPC 丢失正文。原设置页把所有内部参考都呈现为可确认候选；后端正确拒绝后，界面却显示了“修改后的内容”错误文案。候选投影也遗漏了已知来源时间。

现在后端投影 `reviewState: ready | reference-only` 与当前可信 ledger 的 `occurredAt`（缺失保持 null）。ready 仅表示存在已提取的可展示内容，不代表激活授权；最终 scope、source、revision、suppression、conflict 校验仍由既有事务负责。逐条隔离 stale/pending/deleted 来源，不让单条失效击穿面板。

保留原卡片布局。reference-only 明示“未提取出可确认内容”“尚未记住”，提示在对话中重新说明，只提供拒绝。合法候选确认携带显示时的 hash、ID 与 revision。IPC 和 Main host 两个入口均在写 settings 确认事件之前拒绝未解析/空白正文及缺失或不匹配的 hash。确认失败文案不再误称用户进行了修改。

内部 reference、natural predecessor/resolve 关系和合法自然 typed 确认均保留；没有恢复原始正文、回灌旧 unknown/shadow、批量模型重解析或自动晋升。Phase 2/3/H 原提交不包含本次候选修复。

## 验证证据

| 检查 | 实际结果 |
|---|---|
| 合成 baseline 复现 | 三条普通任务生成空正文 reference；盲确认拒绝，正式 facts/evidence 不增加 |
| TDD RED | scratch 契约缺状态/时间；产品四层新增断言 12 项按预期失败后才实施 |
| 相关完整测试 | 4 文件 / 252 项通过；之后补充的错误 hash 参数用例也由冻结全量覆盖 |
| Main / renderer / preload 类型检查 | 均 exit 0 |
| 本地 TypeScript + Vite 构建 | exit 0；保留既有大 chunk 警告，未调整阈值 |
| 冻结全量（与 npm test 同一入口） | **882 文件通过、1 文件失败、1 文件跳过；10867 项通过、5 项失败、11 项跳过；exit 1** |
| 全量失败归因与补验 | 唯一失败套件 `native-history-presence-process.test.ts` 缺少本树的既有 presence helper。复制 H 已编译同 SHA 文件后，受影响整套 **15/15 通过，exit 0**；无源码/断言变化 |
| 真实隔离 Electron | **3 次启动、17 项检查、0 失败、exit 0**；实际设置 UI/preload/IPC/Worker/SQLite，模型 transport 为离线 fake |
| 独立审查 | gpt-6-astra / medium 只读审查无阻塞产品问题；验收脚本退出清理问题已修并独立复核关闭 |
| diff-check | 产品 staged diff 检查通过 |

第一轮相关测试曾有 7 个测试准备问题：6 个既有 typed-edit 测试直调确认未携带新增必需 hash，1 个新增来源删除测试遗漏 prepareChange；调整测试输入后相关完整套件通过。未用产品绕过、放宽断言或改变质量门槛处理。

全量 11 项跳过保留原平台/符号链接门控；详细名称与原因见 archive report，`unhandledErrors=0`。全量不是单次全绿。按用户“只补缺失证据”的要求，补齐现成 helper 并定向复验后没有重复整套全量。

## 冻结与可追溯性

源码 manifest 2910 个文件，SHA-256：
`27e63cf34cdec07f4aaf66f28e0d24466189c89affec852a6bde8a72d757dd86`

全量与 Electron 的 sourceBefore/sourceAfter 均为上述值，`sourceUnchanged=true`；helper 补入后再次计算源码值也一致。本报告是验证完成后的纯文档增量，不属于当时 2910 个产品文件。

本地证据均在候选工作树内：

- 全量：`.verification/runs/candidate-full-1792300989655-8b236dbb/{run.json,output.log,reports,tracked-source-before.json,tracked-source-after.json}`。
- presence 补验：`.verification/runs/candidate-presence-1792301918161-d3900c9f/`。
- helper SHA/源码未变：`.verification/presence-remediation.json`。presence SHA 为 `c361ad522968d87049c9ec8b28b6241ece7d056f3650575992ddaa99c061a5cd`，与 H 原编译品一致。
- Electron 冻结：`.verification/runs/candidate-electron-1792301943050-bbae6128/`。
- Electron 实测：`.verification/electron-candidate-panel-1792301943724-b2a4b135/{result.json,model-requests.ndjson,qa-main.cjs,process.log}`，含三张截图。
- RED/相关测试/构建日志及调查：`E:\Codex\2026-10-17\task\candidate-investigation\`。
- 可复现验收脚本：`scripts/verify/candidate-panel-electron.cjs`。该脚本要求已有本地构建与 helper，不自行安装或编译 helper。

Electron 实际检查：未提取记录明确且可拒绝、没有确认按钮；自然 ready 候选正文和可信时间；实际点击确认的 ID/revision/hash 等于显示 DTO；第一次冷重开后实际新会话请求使用记忆；纠错后的新值进入请求且旧值消失；遗忘后第二次冷重开，请求没有旧记忆或原始历史复活。已目视检查 reference-only 与 ready 截图。

本次 owned Electron PID 为 `40744`、`30732`、`16320`，三次均记录精确退出 `code=0, signal=null`；仅关闭持有句柄的本次实例，没有枚举或终止用户进程。

## 边界与原树状态

收尾只读确认：原 Phase 3 工作树 `firefly-memory-phase2` 仍在 `a38c34829b5d6265b6f6f03b2d642f584ec05340`；H 树仍在 `aa7d3bfa03bea7b2dfc6924dcd05747932d38122`，两者 tracked 状态均干净。本次只改候选独立树。

未访问真实用户 DB/profile/凭据，未运行付费模型、Android、SDK 检查或 EXE 打包安装，未执行外部市场任务，也没有 push、PR、merge 或 deploy。helper 和静态运行资产沿用已有本地编译品。Electron 网络拦截只证明本次脚本覆盖路径，不能泛化为操作系统级网络沙箱。

用户实际运行 commit 未知；界面 1.1.0 不能定位 commit。本地验证不代表用户正在运行的实例已经更新。当前没有剩余实施阻塞。

## 补充：最终提交整套回归（2026-10-18 05:59 UTC）

用户明确要求补齐最终候选提交的一次完整回归。本节更新最终验收结论；前文“没有重复整套全量”描述的是首次交付时的处理，不代表本次补充结果。首次缺件失败及定向复验记录均保留。

- 受测 HEAD：`6a13a41b3454c1f18f57476242aca150074f47c7`；产品提交仍为 `5f9168d68c0565976d0feaa8e2c5dd3e93ad43cb`。
- 启动前核对 debug presence、debug history-read、release history-read 三个现成 helper，均存在且 SHA-256 与 H 验收工作树一致；未编译或打包 helper。
- 命令：`node .verification/run-isolated.cjs candidate-full scripts/testing/run-tests.mjs`，仍使用原完整测试入口、隔离 profile、原超时及原断言。期间未并发运行 Electron，未修改源码。
- 结果：**883 files / 10872 cases 通过，0 失败；1 file / 11 cases 既有跳过，unhandledErrors 为 0；exitCode 0**。Vitest 用时 907.59 秒。
- 此前缺件的 `native-history-presence-process.test.ts` 本次在完整运行中 **15/15 通过**。至此已消除“仅首次全量失败后定向补测”的验收缺口。
- 运行前后 manifest 均为 2911 文件，SHA-256 `a25bf7c6a3c7b61ad22be4fc3d70fe77f72a59c9f665ba2debc449d40bacda57`，`sourceUnchanged=true`。与此前 Electron 验收的 2910 文件逐项比较，全部哈希一致，仅多出本验证文档；并非产品版本改变。

新增证据：

- `.verification/final-full-helper-preflight.json`：三个 helper 的路径、大小、SHA-256 与 H 对照。
- `.verification/final-full-source-preflight.json`：与已通过 Electron 源码的逐项比较。
- `.verification/runs/candidate-full-1792302231166-a758c552/`：完整日志、run.json、运行前后 manifest。
- `.verification/runs/candidate-full-1792302231166-a758c552/reports/2026-10-18T05-43-52-148Z-19e7d01e-3ae1-4d6e-b633-a1f255a6060c/report.json`：结构化结果及既有跳过原因。

本次只补整套回归与文档，不重跑 Electron、不执行 SDK/EXE 打包、不访问用户数据库、不推送、开 PR 或部署。验证后仅提交本报告更新，产品源码保持不变。
