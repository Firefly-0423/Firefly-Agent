# H 检索评测  split=dev  sizes=250  queries=78  seed=20261013

## 粒度=session  规模=250 个会话（250 个检索单元）  有答案查询 69，无答案 9

| 方式 | Hit@1 [95%CI] | Hit@5 | MRR | nDCG@8 | 更正顺序 | p50 ms | p95 ms | 不支持/错误 |
|---|---|---|---|---|---|---|---|---|
| hybrid+prodrecency | 48% [34%–61%] | 67% | 0.56 | 0.59 | 60% | 84 | 100 |  |

按类别 Hit@1：

| 方式 | paraphrase | keyword | correction | context | needle | temporal |
|---|---|---|---|---|---|---|
| hybrid+prodrecency | 29% | 93% | 60% | 100% | 17% | – |

弃答可分性 AUC（用最高分区分"有答案"与"无答案"，0.5=猜，1=完全可分；只有向量或重排器有可比的绝对分数）：
- dense: –
- hybrid+rerank8: –
- hybrid+rerank30: –
- lexical+rerank30: –
- lexical+stop+rerank30: –

## 索引与资源

| 粒度 | 检索单元数 | 本次新算向量 | 耗时 ms | 每个 ms |
|---|---|---|---|---|
| session | 250 | 0 | 1 | 0 |

模型加载：向量 1567 ms，重排器 908 ms；加载后 RSS 2180 MB，运行中峰值 RSS 2368 MB。
注意：纯 Node 环境、合成数据、单线程顺序执行；查询只有几十条，差异小于置信区间宽度时不能算改善。

完整结果：scripts\eval\memory-history\results\2026-10-13-stage-a\dev-units2-alpha-0.05.json
