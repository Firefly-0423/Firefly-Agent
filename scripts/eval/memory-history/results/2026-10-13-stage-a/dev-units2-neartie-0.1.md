# H 检索评测  split=dev  sizes=250  queries=78  seed=20261013

## 粒度=session  规模=250 个会话（250 个检索单元）  有答案查询 69，无答案 9

| 方式 | Hit@1 [95%CI] | Hit@5 | MRR | nDCG@8 | 更正顺序 | p50 ms | p95 ms | 不支持/错误 |
|---|---|---|---|---|---|---|---|---|
| lexical | 51% [38%–62%] | 67% | 0.57 | 0.59 | 40% | 49 | 51 |  |
| lexical+neartie | 49% [37%–61%] | 61% | 0.55 | 0.57 | 50% | 49 | 51 |  |

按类别 Hit@1：

| 方式 | paraphrase | keyword | correction | context | needle | temporal |
|---|---|---|---|---|---|---|
| lexical | 18% | 93% | 40% | 100% | 67% | 100% |
| lexical+neartie | 14% | 93% | 50% | 100% | 67% | – |

时间范围泄漏（前 3 名里落在窗口外的比例，越低越好）：lexical 0%

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

模型加载：向量 1542 ms，重排器 922 ms；加载后 RSS 2175 MB，运行中峰值 RSS 2427 MB。
注意：纯 Node 环境、合成数据、单线程顺序执行；查询只有几十条，差异小于置信区间宽度时不能算改善。

完整结果：scripts\eval\memory-history\results\2026-10-13-stage-a\dev-units2-neartie-0.1.json
