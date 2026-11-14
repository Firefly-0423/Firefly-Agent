# 测试断言整改施工进度

状态：施工中（计划已于 2026-11-15 确认）
施工计划：[2026-11-15-test-assertion-hardening.md](./2026-11-15-test-assertion-hardening.md)

## 1. 当前状态

- 分支：未开
- 进行到：—

## 2. 已完成项

| 任务 | 改动 | 反向验证 | 验证 |
|---|---|---|---|

## 3. 排除（复核后不改）

| 位置 | 原因 |
|---|---|
| `src/main/features/channels/adapters/qqbot/qqbot-api-client.test.ts:177` | 紧接着已断言请求地址、方法和请求体 |
| `src/main/agent/tools/workspace-boundary.test.ts:185` | 已断言 `category: "permission_denied"` |
| `src/main/memory/core/storage-safety.test.ts:83/88/92` | 断言的是测试辅助函数本身抛出的断言失败，没有稳定码可言 |

## 4. 缺稳定错误码

| 位置 | 产品抛出的错误 | 现在改为断言什么 |
|---|---|---|

## 5. 验证记录

| 项 | 最后一次结果 | 日期 |
|---|---|---|

## 6. 偏离计划
