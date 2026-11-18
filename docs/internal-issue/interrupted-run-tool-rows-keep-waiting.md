# 中断的运行重开后，工具行仍显示“进行中”

状态：修复已提 PR（`fix/interrupted-tool-rows`）
日期：2026-11-17

## 现象

运行在等用户回答澄清问题（`ask_user`）时被中断，例如应用被关闭。重新打开后：

- 这条回复已经显示为“流萤这一步没有顺利完成”；
- 但里面的“询问用户”一行仍显示“等待用户回答”并在转圈，下一轮都结束了还是这样。

用户会以为这个问题还在等自己回答。

## 复现

1. Work 模式下发一个会让模型调用 `ask_user` 的任务。
2. 澄清问题出现、还没回答时，关闭应用。
3. 重新打开，进入这个会话。

负责人 2026-11-17 实机发现。

## 根因

`src/renderer/react/features/chat/pages/session-runtime-state.ts` 的 `recoverInterruptedMessage`，在重开时会把未完成的回复改成“上次运行已中断”，停掉所有动画。但它没有处理回复里的工具行和轮次：存成 `running` 的 `ask_user` 仍按“进行中”显示。

这个问题从 1.1.0 就存在。ChatPage 施工包 A 的 A8 测试把“工具行保持原样”一起固定了下来。

## 修复

重开时，中断运行里还是 `running` 的工具行显示为结束（`error`，结果写“上次运行已中断”），还是 `running` 的轮次显示为已完成，完成时间取快照时间。

- 只改显示，存储里的记录不动；
- 已经结束的工具行和轮次原样保留；
- 不显示成成功，也不重放工具。

A8 测试的期望同步改为这个显示，A8 的验收条件（停掉动画、标记中断、保留正文与过程、不伪装成功、不重放工具）不变。

## 相关文件

- `src/renderer/react/features/chat/pages/session-runtime-state.ts`
- `src/renderer/react/features/chat/pages/session-runtime-state.test.ts`
- `src/renderer/react/features/chat/pages/chat-page-normalizers.test.ts`（A8）
