# H 检索评测  split=dev  sizes=250  queries=78  seed=20261013

## 粒度=window  规模=250 个会话（1733 个检索单元）  有答案查询 69，无答案 9

| 方式 | Hit@1 [95%CI] | Hit@5 | MRR | nDCG@8 | 更正顺序 | p50 ms | p95 ms | 不支持/错误 |
|---|---|---|---|---|---|---|---|---|
| lexical+recency | 34% [24%–46%] | 60% | 0.44 | 0.49 | 80% | 51 | 54 |  |
| hybrid+recency | 54% [42%–66%] | 72% | 0.62 | 0.66 | 80% | 103 | 132 |  |
| hybrid+stop+recency | 52% [40%–64%] | 73% | 0.62 | 0.66 | 80% | 98 | 130 |  |

按类别 Hit@1：

| 方式 | paraphrase | keyword | correction | context | needle | temporal |
|---|---|---|---|---|---|---|
| lexical+recency | 4% | 67% | 80% | 50% | 25% | – |
| hybrid+recency | 21% | 80% | 80% | 100% | 67% | – |
| hybrid+stop+recency | 21% | 80% | 80% | 100% | 58% | – |

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

模型加载：向量 1806 ms，重排器 1013 ms；加载后 RSS 2203 MB，运行中峰值 RSS 3268 MB。
注意：纯 Node 环境、合成数据、单线程顺序执行；查询只有几十条，差异小于置信区间宽度时不能算改善。

完整结果：scripts\eval\memory-history\results\2026-10-13\dev-window-alpha-0.3.json
