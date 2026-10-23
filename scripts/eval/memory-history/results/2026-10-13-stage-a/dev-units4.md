# H 检索评测  split=dev  sizes=250  queries=78  seed=20261013

## 粒度=session  规模=250 个会话（250 个检索单元）  有答案查询 69，无答案 9

| 方式 | Hit@1 [95%CI] | Hit@5 | MRR | nDCG@8 | 更正顺序 | p50 ms | p95 ms | 不支持/错误 |
|---|---|---|---|---|---|---|---|---|
| lexical | 49% [36%–61%] | 65% | 0.56 | 0.59 | 40% | 48 | 52 |  |
| hybrid | 45% [33%–58%] | 64% | 0.52 | 0.56 | 40% | 83 | 107 | 2 |
| hybrid+prodrecency | 49% [37%–63%] | 66% | 0.56 | 0.59 | 80% | 82 | 111 |  |

按类别 Hit@1：

| 方式 | paraphrase | keyword | correction | context | needle | temporal |
|---|---|---|---|---|---|---|
| lexical | 21% | 93% | 40% | 100% | 50% | 100% |
| hybrid | 36% | 87% | 40% | 100% | 17% | 0% |
| hybrid+prodrecency | 25% | 93% | 80% | 100% | 17% | – |

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

模型加载：向量 1608 ms，重排器 960 ms；加载后 RSS 2167 MB，运行中峰值 RSS 2516 MB。
注意：纯 Node 环境、合成数据、单线程顺序执行；查询只有几十条，差异小于置信区间宽度时不能算改善。

完整结果：scripts\eval\memory-history\results\2026-10-13-stage-a\dev-units4.json
