# H 检索评测  split=dev  sizes=250  queries=78  seed=20261013

## 粒度=window  规模=250 个会话（1733 个检索单元）  有答案查询 69，无答案 9

| 方式 | Hit@1 [95%CI] | Hit@5 | MRR | nDCG@8 | 更正顺序 | p50 ms | p95 ms | 不支持/错误 |
|---|---|---|---|---|---|---|---|---|
| lexical+recency | 43% [31%–55%] | 64% | 0.52 | 0.55 | 70% | 52 | 60 |  |
| hybrid+recency | 60% [46%–72%] | 78% | 0.67 | 0.70 | 80% | 106 | 147 |  |
| hybrid+stop+recency | 64% [52%–75%] | 78% | 0.70 | 0.72 | 80% | 98 | 138 |  |

按类别 Hit@1：

| 方式 | paraphrase | keyword | correction | context | needle | temporal |
|---|---|---|---|---|---|---|
| lexical+recency | 4% | 87% | 70% | 100% | 50% | – |
| hybrid+recency | 25% | 93% | 80% | 100% | 75% | – |
| hybrid+stop+recency | 32% | 93% | 80% | 100% | 83% | – |

弃答可分性 AUC（用最高分区分"有答案"与"无答案"，0.5=猜，1=完全可分；只有向量或重排器有可比的绝对分数）：
- dense: –
- hybrid+rerank8: –
- hybrid+rerank30: –
- lexical+rerank30: –
- lexical+stop+rerank30: –

## 索引与资源

| 粒度 | 检索单元数 | 本次新算向量 | 耗时 ms | 每个 ms |
|---|---|---|---|---|
| window | 1733 | 0 | 2 | 0 |

模型加载：向量 1576 ms，重排器 1071 ms；加载后 RSS 2142 MB，运行中峰值 RSS 3196 MB。
注意：纯 Node 环境、合成数据、单线程顺序执行；查询只有几十条，差异小于置信区间宽度时不能算改善。

完整结果：scripts\eval\memory-history\results\2026-10-13\dev-window-alpha-0.1.json
