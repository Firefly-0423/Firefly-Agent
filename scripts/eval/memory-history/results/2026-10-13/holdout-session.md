# H 检索评测  split=holdout  sizes=250,512  queries=25  seed=20261013

## 粒度=session  规模=250 个会话（250 个检索单元）  有答案查询 22，无答案 3

| 方式 | Hit@1 [95%CI] | Hit@5 | MRR | nDCG@8 | 更正顺序 | p50 ms | p95 ms | 不支持/错误 |
|---|---|---|---|---|---|---|---|---|
| lexical | 45% [23%–68%] | 77% | 0.58 | 0.63 | 0% | 46 | 55 |  |
| hybrid | 55% [32%–77%] | 68% | 0.61 | 0.65 | 0% | 83 | 97 | 1 |
| hybrid+rerank8 | 41% [23%–64%] | 68% | 0.55 | 0.60 | 0% | 868 | 996 | 1 |
| hybrid+stop+recency | 67% [48%–86%] | 76% | 0.71 | 0.73 | 67% | 74 | 99 |  |

按类别 Hit@1：

| 方式 | paraphrase | keyword | correction | context | needle | temporal |
|---|---|---|---|---|---|---|
| lexical | 38% | 80% | 0% | 100% | 25% | 100% |
| hybrid | 50% | 100% | 0% | 100% | 50% | 0% |
| hybrid+rerank8 | 38% | 100% | 0% | 100% | 0% | 0% |
| hybrid+stop+recency | 50% | 100% | 67% | 100% | 50% | – |

时间范围泄漏（前 3 名里落在窗口外的比例，越低越好）：lexical 0%

弃答可分性 AUC（用最高分区分"有答案"与"无答案"，0.5=猜，1=完全可分；只有向量或重排器有可比的绝对分数）：
- dense: –
- hybrid+rerank8: 0.83
- hybrid+rerank30: –
- lexical+rerank30: –
- lexical+stop+rerank30: –

## 粒度=session  规模=512 个会话（512 个检索单元）  有答案查询 22，无答案 3

| 方式 | Hit@1 [95%CI] | Hit@5 | MRR | nDCG@8 | 更正顺序 | p50 ms | p95 ms | 不支持/错误 |
|---|---|---|---|---|---|---|---|---|
| lexical | 45% [23%–68%] | 73% | 0.58 | 0.62 | 0% | 65 | 78 |  |
| hybrid | 55% [32%–77%] | 68% | 0.60 | 0.62 | 0% | 102 | 126 | 1 |
| hybrid+rerank8 | 41% [23%–64%] | 59% | 0.51 | 0.55 | 0% | 841 | 1072 | 1 |
| hybrid+stop+recency | 67% [48%–86%] | 76% | 0.71 | 0.73 | 67% | 90 | 124 |  |

按类别 Hit@1：

| 方式 | paraphrase | keyword | correction | context | needle | temporal |
|---|---|---|---|---|---|---|
| lexical | 38% | 80% | 0% | 100% | 25% | 100% |
| hybrid | 50% | 100% | 0% | 100% | 50% | 0% |
| hybrid+rerank8 | 38% | 100% | 0% | 100% | 0% | 0% |
| hybrid+stop+recency | 50% | 100% | 67% | 100% | 50% | – |

时间范围泄漏（前 3 名里落在窗口外的比例，越低越好）：lexical 0%

弃答可分性 AUC（用最高分区分"有答案"与"无答案"，0.5=猜，1=完全可分；只有向量或重排器有可比的绝对分数）：
- dense: –
- hybrid+rerank8: 0.75
- hybrid+rerank30: –
- lexical+rerank30: –
- lexical+stop+rerank30: –

## 索引与资源

| 粒度 | 检索单元数 | 本次新算向量 | 耗时 ms | 每个 ms |
|---|---|---|---|---|
| session | 512 | 0 | 1 | 0 |

模型加载：向量 1634 ms，重排器 971 ms；加载后 RSS 2214 MB，运行中峰值 RSS 2516 MB。
注意：纯 Node 环境、合成数据、单线程顺序执行；查询只有几十条，差异小于置信区间宽度时不能算改善。

完整结果：scripts\eval\memory-history\results\2026-10-13\holdout-session.json
