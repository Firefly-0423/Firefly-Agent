# H 检索评测  split=holdout  sizes=250,512  queries=25  seed=20261013

## 粒度=session  规模=250 个会话（250 个检索单元）  有答案查询 22，无答案 3

| 方式 | Hit@1 [95%CI] | Hit@5 | MRR | nDCG@8 | 更正顺序 | p50 ms | p95 ms | 不支持/错误 |
|---|---|---|---|---|---|---|---|---|
| lexical | 55% [32%–77%] | 77% | 0.64 | 0.68 | 0% | 64 | 87 |  |
| hybrid | 59% [36%–82%] | 73% | 0.64 | 0.67 | 33% | 84 | 94 | 1 |
| hybrid+prodrecency | 62% [38%–81%] | 76% | 0.69 | 0.72 | 67% | 84 | 95 |  |
| hybrid+rerank8 | 50% [27%–73%] | 68% | 0.59 | 0.64 | 0% | 826 | 937 | 1 |

按类别 Hit@1：

| 方式 | paraphrase | keyword | correction | context | needle | temporal |
|---|---|---|---|---|---|---|
| lexical | 38% | 80% | 0% | 100% | 75% | 100% |
| hybrid | 50% | 100% | 33% | 100% | 50% | 0% |
| hybrid+prodrecency | 50% | 80% | 67% | 100% | 50% | – |
| hybrid+rerank8 | 50% | 100% | 0% | 100% | 25% | 0% |

时间范围泄漏（前 3 名里落在窗口外的比例，越低越好）：lexical 0%

弃答可分性 AUC（用最高分区分"有答案"与"无答案"，0.5=猜，1=完全可分；只有向量或重排器有可比的绝对分数）：
- dense: –
- hybrid+rerank8: 0.84
- hybrid+rerank30: –
- lexical+rerank30: –
- lexical+stop+rerank30: –

## 粒度=session  规模=512 个会话（512 个检索单元）  有答案查询 22，无答案 3

| 方式 | Hit@1 [95%CI] | Hit@5 | MRR | nDCG@8 | 更正顺序 | p50 ms | p95 ms | 不支持/错误 |
|---|---|---|---|---|---|---|---|---|
| lexical | 55% [32%–77%] | 77% | 0.64 | 0.68 | 0% | 80 | 82 |  |
| hybrid | 59% [36%–82%] | 68% | 0.64 | 0.67 | 33% | 102 | 106 | 1 |
| hybrid+prodrecency | 62% [38%–81%] | 76% | 0.68 | 0.70 | 67% | 103 | 112 |  |
| hybrid+rerank8 | 45% [23%–68%] | 73% | 0.58 | 0.63 | 0% | 840 | 993 | 1 |

按类别 Hit@1：

| 方式 | paraphrase | keyword | correction | context | needle | temporal |
|---|---|---|---|---|---|---|
| lexical | 38% | 80% | 0% | 100% | 75% | 100% |
| hybrid | 50% | 100% | 33% | 100% | 50% | 0% |
| hybrid+prodrecency | 50% | 80% | 67% | 100% | 50% | – |
| hybrid+rerank8 | 50% | 100% | 0% | 100% | 0% | 0% |

时间范围泄漏（前 3 名里落在窗口外的比例，越低越好）：lexical 0%

弃答可分性 AUC（用最高分区分"有答案"与"无答案"，0.5=猜，1=完全可分；只有向量或重排器有可比的绝对分数）：
- dense: –
- hybrid+rerank8: 0.83
- hybrid+rerank30: –
- lexical+rerank30: –
- lexical+stop+rerank30: –

## 索引与资源

| 粒度 | 检索单元数 | 本次新算向量 | 耗时 ms | 每个 ms |
|---|---|---|---|---|
| session | 512 | 0 | 1 | 0 |

模型加载：向量 1537 ms，重排器 959 ms；加载后 RSS 2207 MB，运行中峰值 RSS 3029 MB。
注意：纯 Node 环境、合成数据、单线程顺序执行；查询只有几十条，差异小于置信区间宽度时不能算改善。

完整结果：scripts\eval\memory-history\results\2026-10-13-stage-a\holdout-units2.json
