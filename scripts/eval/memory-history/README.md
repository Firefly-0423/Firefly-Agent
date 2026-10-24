# H（历史检索）离线评测

回答一个问题：**改动检索之前，现在到底有多准、多慢、多占内存；改动之后有没有真的变好。**

它直接调用生产代码，而不是另写一套：

| 环节 | 生产代码 |
|---|---|
| 排序（BM25、向量、RRF、MMR、时间过滤） | `src/main/memory-history/history-ranking.ts` 的 `rankHistory` |
| 向量 | `src/main/rag/embedding.ts` 的本地 BGE-M3 |
| 重排 | `src/main/rag/reranker.ts` 的本地 bge-reranker-base |

评测的是**排序层**。授权、来源校验、预算裁剪、遗忘等治理逻辑不在范围内，它们有各自的测试。

## 运行

```bash
npm run eval:memory-history                       # 规模 250 和 512，session 与 window 两种粒度，只看 dev
npm run eval:memory-history -- --sizes 250 --granularity session
npm run eval:memory-history -- --split holdout    # 最后一次对比才用
npm run test:eval                                 # 指标与数据集的单元测试
```

参数：`--sizes`（会话数，逗号分隔）、`--granularity`（`session`、`window`）、`--split`（`dev`、`holdout`、`all`）、`--seed`、`--out`。

其余参数：`--modes`（只跑指定方式）、`--label`（结果文件名）、`--cache`（向量缓存路径）、`--units N`（整段粒度下词法按 N 轮一个窗口计分，对应生产设置 `windowTurns`）、`--recency-alpha`、`--recency-halflife`、`--long-turns N`（长会话基础轮数，默认 160 约 3000 字；450 约 7500 字，超过 6000 字摘录预算）、`--context-windows N`（摘录时最佳窗口两侧各扩几个窗口）。

带 `--units` 的整段粒度运行，对 needle 类题额外输出**证据召回**：按生产的摘录预算打包后，关键句有没有真的送达（"整份或丢弃"对"仅对超长会话摘录"）。

首次运行会为每个会话算向量，几分钟。结果打印为表格，并把完整的逐查询排名写到 `output/memory-eval/*.json`（已被 git 忽略）。
需要本机已有 `models/Xenova/bge-m3` 和 `models/bge-reranker-base`。

## 数据

全部是虚构内容，固定种子，同样的参数生成同样的数据（`dataset.mjs`、`generated.mjs`）。

| 类别 | 考察什么 |
|---|---|
| paraphrase | 查询与事实几乎没有共同词（"来杯热拿铁" 对 "喝不惯咖啡"），部分带有共享关键词的困难负例 |
| keyword | 事实里有独有的名字或编号，负例是近似的另一个实体（`Aurora-6` 与 `Aurora-7`） |
| correction | 同一事实先后两个版本，新版本必须排在旧版本前面 |
| context | 同一会话里有多个情境（对客户用英文、自己笔记用中文） |
| needle | 约 2600 字的长会话里只有一句相关的话 |
| temporal | 带时间范围或"最近一次"的查询 |
| no-answer | 库里没有任何相关事实，用来看能不能区分"有"和"没有" |

规则：

- `split=dev` 用来看结果、调参。`split=holdout` **不得用于调参**，只在最后一次对比时跑一遍，防止对着答案优化。
- 填充会话（干扰项）的词表不得包含任何查询关键词，`assertNoLeakage` 在每次运行和单元测试里校验。
- 新增用例写在 `generated.mjs` 的数组里，并给出独有关键词；不要只换说法凑数量，同一事实的多种问法不是独立样本。

## 检索方式

| 名称 | 含义 |
|---|---|
| `lexical` | 生产默认：分词 + BM25 |
| `lexical+stop` | 实验：同上，但丢弃停用词（生产分词器没有使用已有的 `isStop` 标记） |
| `dense` | 只用向量余弦（仅评测用，生产没有） |
| `hybrid` | 生产本地检索路径的排序部分：BM25 + 向量 + RRF + MMR |
| `hybrid+stop` | 实验：`hybrid` + 去停用词 |
| `hybrid+rerank8` | 生产本地路径：混合排序取 8 条再重排 |
| `hybrid+rerank30` | 实验：混合排序的前 30 个候选重排后取 8 |
| `lexical+rerank30` | 实验：不用向量，词法候选重排，省掉向量模型的内存 |
| `lexical+stop+rerank30` | 实验：同上，词法部分去停用词 |
| `hybrid+rangefilter` | 实验：先按时间范围过滤，再混合排序（模拟"范围查询 + 向量"的修复）。不含"最近一次" |

生产里时间查询与向量互斥，直接抛 `MEMORY_HISTORY_TEMPORAL_VECTOR_UNSUPPORTED`。评测把它记为"不支持"，**按未命中计入分母**，避免只在容易的查询上比较。

## 粒度

- `session`：整段会话一个检索单元，等同生产的 `captureTranscript`（整段会话拼接后做一个向量）。
- `window`：每两轮一个检索单元，指标仍按会话统计。这是实验，用来量化"整段做向量会稀释"。

## 指标怎么读

- **Hit@k**：前 k 名里有没有标准答案。**MRR**、**nDCG@8** 看名次。
- **更正顺序**：新事实是否排在被取代的旧事实前面。
- **时间范围泄漏**：前 3 名里落在时间窗口外的比例，应为 0。
- **弃答可分性 AUC**：用最高分区分"有答案"与"无答案"，0.5 等于猜，1 是完全可分。只有向量和重排器给出的是可比较的绝对分数。
- **置信区间**：自助法 95% 区间。有答案的查询只有几十条，**两种方式的区间重叠时，不能说谁更好**。
- **延迟**：单条查询从取向量到排序结束，本机顺序执行，不含网络。

## 局限

- 纯 Node 环境，不是 Electron 里的真实进程，没有并发和前台竞争。
- 数据是合成的，措辞比真实对话规整，真实场景的难度更高；它是决策和回归工具，不是质量证明。
- 内存数字是 RSS，含加载与运行期间的峰值，受 V8 回收时机影响。
- 只评估排序，不评估"检索到之后模型怎么用"。
