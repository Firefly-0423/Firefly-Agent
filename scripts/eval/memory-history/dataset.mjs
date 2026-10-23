// 合成评测数据：会话（对应生产里的 transcript 文档）与带标准答案的查询。
// 全部是虚构内容；固定种子，同一参数永远生成同一份数据。
//
// 设计约束：
// - 每个查询只在 gold 会话里有答案；"困难负例"故意与查询共享关键词但事实不同。
// - 干扰会话从模板生成，词表避开所有查询的关键词，由 assertNoLeakage 校验。
// - split=holdout 的查询不得用于调参，只在最后一次对比时使用。

import { mulberry32 } from "./metrics.mjs";
import { CORRECTION, KEYWORD, NEEDLE, NO_ANSWER, PARAPHRASE, generatedKeys } from "./generated.mjs";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
// 2026-10-13 12:00 (Asia/Shanghai)
export const NOW = Date.UTC(2026, 9, 13, 4, 0, 0);
const shanghai = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h - 8, min);

function session(id, at, turns) {
  return {
    id,
    turns: turns.map(([role, text], i) => ({ role, text, occurredAt: at + i * MINUTE })),
  };
}
const daysAgo = (n, hour = 10) => NOW - n * DAY + (hour - 12) * 60 * MINUTE;

// ── 手写核心用例 ─────────────────────────────────────────────────────────────
function coreCases() {
  const sessions = [];
  const queries = [];
  const add = (s) => sessions.push(s);
  const q = (id, category, split, text, gold, extra = {}) =>
    queries.push({ id, category, split, text, gold, answerable: true, ...extra });

  // A. 换一种说法（词面几乎不重合）
  add(session("s-coffee", daysAgo(31), [
    ["user", "我在写流体力学结课论文，喝不惯咖啡，偶尔嚼薄荷糖提神。"],
    ["assistant", "了解，写论文辛苦了，薄荷糖是个不错的选择。需要我帮你整理参考文献吗？"],
  ]));
  add(session("n-coffee-machine", daysAgo(26), [
    ["user", "家用咖啡机能打奶泡做拿铁吗？预算八百以内。"],
    ["assistant", "带蒸汽棒的入门机型可以，打奶泡需要一点练习，建议先看看口碑好的两款。"],
  ]));
  q("q-coffee", "paraphrase", "dev", "来杯热拿铁怎么样？", ["s-coffee"]);

  add(session("s-sleep", daysAgo(40), [
    ["user", "我一般十二点半才睡，早上八点起床，晚上精神最好。"],
    ["assistant", "好的，我会按你的作息来安排提醒，不会太早打扰你。"],
  ]));
  add(session("n-alarm", daysAgo(33), [
    ["user", "想买个新闹钟，早上起床用，有推荐吗？"],
    ["assistant", "可以考虑带渐亮灯光的款式，叫醒更温和。"],
  ]));
  q("q-sleep", "paraphrase", "dev", "晚上十点提醒我休息，会不会太早了？", ["s-sleep"]);

  add(session("s-cilantro", daysAgo(22), [
    ["user", "提前说一下，我不吃香菜，一点都不行，闻到就难受。"],
    ["assistant", "记下了，之后推荐菜品会避开香菜。"],
  ]));
  add(session("n-cilantro-recipe", daysAgo(15), [
    ["user", "教我做个香菜拌牛肉吧，周末请朋友吃饭。"],
    ["assistant", "牛腱子卤好切片，和香菜、辣椒油、花椒油一起拌就行。"],
  ]));
  q("q-cilantro", "paraphrase", "dev", "帮我点一碗牛肉面，配菜有什么推荐？", ["s-cilantro"]);

  add(session("s-commute", daysAgo(28), [
    ["user", "我每天骑自行车去公司，单程大概二十分钟。"],
    ["assistant", "不错的通勤方式，既锻炼又不堵车。"],
  ]));
  add(session("n-tire", daysAgo(19), [
    ["user", "自行车胎压打多少比较合适？"],
    ["assistant", "城市通勤胎一般在 40 到 60 PSI 之间，具体看胎侧标注。"],
  ]));
  q("q-commute", "paraphrase", "holdout", "下雨天出门上班有什么建议？", ["s-commute"]);

  add(session("s-pet", daysAgo(35), [
    ["user", "我家橘猫叫团子，三岁了，最近掉毛特别厉害。"],
    ["assistant", "换季掉毛很常见，多梳理、补充营养会有帮助。"],
  ]));
  add(session("n-litter", daysAgo(21), [
    ["user", "猫砂选豆腐砂还是膨润土比较好？"],
    ["assistant", "豆腐砂粉尘少、可冲厕所，膨润土结团更好，看你的优先级。"],
  ]));
  q("q-pet", "paraphrase", "dev", "宠物梳毛用什么刷子好？", ["s-pet"]);

  add(session("s-japanese", daysAgo(45), [
    ["user", "我在自学日语，目标是明年七月考 N2。"],
    ["assistant", "有明确目标很好，可以按月拆分语法和词汇的进度。"],
  ]));
  add(session("n-japan-trip", daysAgo(38), [
    ["user", "日本旅游的签证现在怎么办理？"],
    ["assistant", "需要在受理机构提交材料，建议提前一个月准备。"],
  ]));
  q("q-japanese", "paraphrase", "dev", "有什么适合备考的背单词方法？", ["s-japanese"]);

  // B. 关键词与实体
  add(session("s-aurora-budget", daysAgo(17), [
    ["user", "Aurora-7 的预算上限定了，八十万，超出要走审批。"],
    ["assistant", "收到，我会在排期里按八十万的上限控制开销。"],
  ]));
  add(session("n-aurora-release", daysAgo(14), [
    ["user", "Aurora-7 的发布时间初步定在十一月中旬。"],
    ["assistant", "好的，我先按这个时间倒推里程碑。"],
  ]));
  add(session("n-aurora6", daysAgo(60), [
    ["user", "Aurora-6 的预算上限是三十万，已经结项了。"],
    ["assistant", "明白，已归档。"],
  ]));
  q("q-aurora", "keyword", "dev", "Aurora-7 的预算上限是多少？", ["s-aurora-budget"]);

  add(session("s-linzhou", daysAgo(12), [
    ["user", "项目甲的林舟负责海报，项目乙的林舟负责音频。"],
    ["assistant", "明白，两个项目里的林舟分工不同，我会分开记。"],
  ]));
  add(session("n-linzhou-leave", daysAgo(9), [
    ["user", "林舟周五请假，评审需要换个时间。"],
    ["assistant", "好的，我来问问其他人的空档。"],
  ]));
  q("q-linzhou", "keyword", "dev", "项目乙的林舟负责什么？", ["s-linzhou"]);

  add(session("s-pnpm", daysAgo(24), [
    ["user", "团队约定统一用 pnpm，不要用 npm 和 yarn。"],
    ["assistant", "记住了，之后给命令时都用 pnpm。"],
  ]));
  add(session("n-npm-error", daysAgo(16), [
    ["user", "npm install 报 EACCES 权限错误怎么处理？"],
    ["assistant", "通常是全局目录权限问题，可以改用用户目录作为全局前缀。"],
  ]));
  q("q-pnpm", "keyword", "holdout", "安装依赖应该用哪个包管理器？", ["s-pnpm"]);

  add(session("s-flight", daysAgo(5), [
    ["user", "我订了航班 MU5301，周五 14:20 起飞，T2 航站楼。"],
    ["assistant", "好的，周五我会提前提醒你出发时间。"],
  ]));
  add(session("n-flight-other", daysAgo(4), [
    ["user", "朋友的航班是 MU5310，周六 09:05 起飞。"],
    ["assistant", "了解，周六早班机，注意早点起床。"],
  ]));
  q("q-flight", "keyword", "dev", "周五的航班几点起飞？", ["s-flight"]);

  // C. 更正：新事实必须排在旧事实前面
  add(session("s-qinghe-old", daysAgo(15), [
    ["user", "青禾演示定在 10 月 20 日，下午两点开始。"],
    ["assistant", "好的，我先按 10 月 20 日准备。"],
  ]));
  add(session("s-qinghe-new", daysAgo(6), [
    ["user", "更正一下，青禾演示改到 10 月 22 日了，时间不变。"],
    ["assistant", "已更新，青禾演示是 10 月 22 日。"],
  ]));
  add(session("n-qinghe-cover", daysAgo(10), [
    ["user", "青禾演示的封面用蓝色，标题要大一点。"],
    ["assistant", "好的，封面用蓝色。"],
  ]));
  add(session("n-qinghe-price", daysAgo(8), [
    ["user", "青禾那边的供应商报价是十二万，比预期高。"],
    ["assistant", "可以先谈一轮价格再决定。"],
  ]));
  q("q-qinghe", "correction", "dev", "青禾演示是几号？", ["s-qinghe-new"], { newer: "s-qinghe-new", older: "s-qinghe-old" });

  add(session("s-theme-old", daysAgo(50), [
    ["user", "我偏好琥珀色的界面主题，看着舒服。"],
    ["assistant", "好的，之后默认用琥珀色。"],
  ]));
  add(session("s-theme-new", daysAgo(11), [
    ["user", "我现在改用银色主题了，琥珀色看久了太晃眼。"],
    ["assistant", "已记录，主题改为银色。"],
  ]));
  q("q-theme", "correction", "dev", "我的界面主题偏好是什么颜色？", ["s-theme-new"], { newer: "s-theme-new", older: "s-theme-old" });

  add(session("s-city-old", daysAgo(30), [
    ["user", "我下个月搬去杭州，已经在看房了。"],
    ["assistant", "祝顺利，需要的话我可以帮你整理租房清单。"],
  ]));
  add(session("s-city-new", daysAgo(7), [
    ["user", "计划有变，不去杭州了，改去成都。"],
    ["assistant", "好的，目的地改为成都。"],
  ]));
  q("q-city", "correction", "holdout", "我要搬去哪个城市？", ["s-city-new"], { newer: "s-city-new", older: "s-city-old" });

  add(session("s-cloud-old", daysAgo(27), [
    ["user", "云迁移项目的预算先按五十万定。"],
    ["assistant", "收到，先按五十万规划。"],
  ]));
  add(session("s-cloud-new", daysAgo(3), [
    ["user", "云迁移项目预算追加到六十五万，财务已经批了。"],
    ["assistant", "已更新，预算是六十五万。"],
  ]));
  q("q-cloud", "correction", "dev", "云迁移项目现在的预算是多少？", ["s-cloud-new"], { newer: "s-cloud-new", older: "s-cloud-old" });

  // D. 多情境与分工
  add(session("s-lang-ctx", daysAgo(20), [
    ["user", "对客户我用英文沟通，自己做笔记用中文。"],
    ["assistant", "明白，对外英文，个人笔记中文。"],
  ]));
  q("q-lang-client", "context", "dev", "给客户发邮件应该用什么语言？", ["s-lang-ctx"]);
  q("q-lang-notes", "context", "dev", "我的笔记用什么语言写？", ["s-lang-ctx"]);

  add(session("s-schedule", daysAgo(8), [
    ["user", "周二下午三点和客户开会，周四上午是内部评审。"],
    ["assistant", "记下了：周二客户会，周四内部评审。"],
  ]));
  q("q-schedule", "context", "holdout", "和客户开会是周几？", ["s-schedule"]);

  // E. 长会话里的一句话（整段会话做向量会稀释）
  const needles = [
    { id: "s-long-passport", at: 18, split: "dev", text: "对了，我的护照下个月 15 号到期，记得提醒我去换。", q: "什么时候要换护照？" },
    { id: "s-long-backup", at: 13, split: "dev", text: "仓库的备份任务是每周日凌晨两点跑的。", q: "备份任务什么时候执行？" },
    { id: "s-long-gift", at: 9, split: "holdout", text: "我弟弟下周生日，想送他一个机械键盘。", q: "要给弟弟准备什么礼物？" },
    { id: "s-long-client", at: 25, split: "dev", text: "客户那边说了，周五下午不要安排会议。", q: "什么时候不能约客户开会？" },
  ];
  for (const n of needles) {
    add({ id: n.id, needle: n.text, turns: [], at: daysAgo(n.at) });
    q(`q-${n.id.slice(2)}`, "needle", n.split, n.q, [n.id]);
  }

  // G. 时间范围与"最近一次"
  const lastWeek = { from: shanghai(2026, 10, 5), to: shanghai(2026, 10, 11, 23, 59) };
  add(session("s-date-w0", shanghai(2026, 9, 24, 15), [
    ["user", "改日期了，周例会从周三挪到周四。"],
    ["assistant", "好的，已经更新周例会时间。"],
  ]));
  add(session("s-date-w1a", shanghai(2026, 10, 6, 11), [
    ["user", "又要改日期，评审往后推一天。"],
    ["assistant", "收到，评审顺延一天。"],
  ]));
  add(session("s-date-w1b", shanghai(2026, 10, 9, 16), [
    ["user", "发布会改日期了，改到下周三。"],
    ["assistant", "已记录，发布会改到下周三。"],
  ]));
  add(session("s-date-w2", shanghai(2026, 10, 12, 10), [
    ["user", "培训也改日期了，挪到月底。"],
    ["assistant", "好的，培训改到月底。"],
  ]));
  q("q-date-range", "temporal", "dev", "上周改日期的事", ["s-date-w1a", "s-date-w1b"], { temporal: { kind: "range", ...lastWeek } });

  add(session("s-trip-old", daysAgo(30), [
    ["user", "想找时间去海边旅行，放松几天。"],
    ["assistant", "可以先看看淡季的机票。"],
  ]));
  add(session("s-trip-mid", daysAgo(17), [
    ["user", "旅行的话，我更想去山里徒步。"],
    ["assistant", "山里徒步需要提前看天气和装备。"],
  ]));
  add(session("s-trip-new", daysAgo(5), [
    ["user", "国庆之后我又在想旅行的事，想去看红叶。"],
    ["assistant", "十月下旬是看红叶的好时候，可以提前订住宿。"],
  ]));
  q("q-trip-latest", "temporal", "dev", "最近一次聊到旅行", ["s-trip-new"], { temporal: { kind: "latest" } });

  const lastMonth = { from: shanghai(2026, 9, 1), to: shanghai(2026, 9, 30, 23, 59) };
  add(session("s-read-a", shanghai(2026, 8, 28, 20), [
    ["user", "我的读书计划是每周读完一本小说。"],
    ["assistant", "这个节奏不错，可以按周记录进度。"],
  ]));
  add(session("s-read-b", shanghai(2026, 9, 12, 21), [
    ["user", "读书计划调整一下，改成每月两本非虚构。"],
    ["assistant", "好的，读书计划改为每月两本非虚构。"],
  ]));
  add(session("s-read-c", shanghai(2026, 10, 3, 20), [
    ["user", "读书计划最近完成得不太好，想重新安排。"],
    ["assistant", "可以先把目标降低一点，保证能坚持。"],
  ]));
  q("q-read-range", "temporal", "holdout", "上个月聊过的读书计划", ["s-read-b"], { temporal: { kind: "range", ...lastMonth } });

  // F. 无答案：库里没有任何相关事实
  const none = [
    ["q-none-seat", "我上次坐的是第几排？"],
    ["q-none-team", "我最喜欢的足球队是哪支？"],
    ["q-none-child", "我女儿今年多大了？"],
    ["q-none-trip", "我去年夏天去哪里旅行了？"],
    ["q-none-blood", "我的血型是什么？"],
    ["q-none-plate", "我的车牌号是多少？"],
  ];
  none.forEach(([id, text], i) => queries.push({ id, category: "no-answer", split: i % 3 === 2 ? "holdout" : "dev", text, gold: [], answerable: false }));

  return { sessions, queries };
}


// ── 批量用例（见 generated.mjs） ─────────────────────────────────────────────
function generatedCases() {
  const sessions = [];
  const queries = [];
  const split = (i) => (i % 4 === 3 ? "holdout" : "dev");
  const add = (s) => sessions.push(s);
  PARAPHRASE.forEach(([key, fact, ack, query, negative], i) => {
    const id = `g-p${String(i).padStart(2, "0")}`;
    add(session(id, daysAgo(8 + ((i * 7) % 50)), [["user", fact], ["assistant", ack]]));
    if (negative) add(session(`gn-p${String(i).padStart(2, "0")}`, daysAgo(5 + ((i * 11) % 45)), [["user", negative[0]], ["assistant", negative[1]]]));
    queries.push({ id: `q-${id}`, category: "paraphrase", split: split(i), text: query, gold: [id], answerable: true });
  });
  KEYWORD.forEach(([key, fact, ack, query, negative], i) => {
    const id = `g-k${String(i).padStart(2, "0")}`;
    add(session(id, daysAgo(6 + ((i * 5) % 40)), [["user", fact], ["assistant", ack]]));
    if (negative) add(session(`gn-k${String(i).padStart(2, "0")}`, daysAgo(4 + ((i * 9) % 35)), [["user", negative[0]], ["assistant", negative[1]]]));
    queries.push({ id: `q-${id}`, category: "keyword", split: split(i), text: query, gold: [id], answerable: true });
  });
  CORRECTION.forEach(([key, older, newer, query], i) => {
    const base = `g-c${String(i).padStart(2, "0")}`;
    add(session(`${base}-old`, daysAgo(30 + ((i * 3) % 20)), [["user", older], ["assistant", "好的，记下了。"]]));
    add(session(`${base}-new`, daysAgo(3 + ((i * 2) % 12)), [["user", newer], ["assistant", "已更新。"]]));
    queries.push({ id: `q-${base}`, category: "correction", split: split(i), text: query, gold: [`${base}-new`], newer: `${base}-new`, older: `${base}-old`, answerable: true });
  });
  NEEDLE.forEach(([key, text, query], i) => {
    const id = `g-n${String(i).padStart(2, "0")}`;
    sessions.push({ id, needle: text, turns: [], at: daysAgo(7 + ((i * 6) % 45)) });
    queries.push({ id: `q-${id}`, category: "needle", split: split(i), text: query, gold: [id], answerable: true });
  });
  NO_ANSWER.forEach((text, i) => queries.push({ id: `q-none-g${i}`, category: "no-answer", split: split(i), text, gold: [], answerable: false }));
  return { sessions, queries };
}

// ── 长会话填充 ──────────────────────────────────────────────────────────────
const CHATTER = [
  ["user", "今天天气不错，下班想出去走走。"], ["assistant", "走一走挺好的，注意傍晚降温。"],
  ["user", "最近有什么好看的纪录片吗？"], ["assistant", "可以看看自然题材的，画面很舒服。"],
  ["user", "帮我想想周末的早餐吃什么。"], ["assistant", "煎蛋配全麦面包和水果就很均衡。"],
  ["user", "这周的会议有点多，有点累。"], ["assistant", "适当留出一段不被打扰的时间会好一些。"],
  ["user", "有什么放松的小办法吗？"], ["assistant", "可以试试深呼吸，或者起身活动五分钟。"],
  ["user", "我想把桌面整理一下。"], ["assistant", "先清掉不用的文件，再按用途分文件夹。"],
  ["user", "晚上想听点轻音乐。"], ["assistant", "钢琴曲或者环境音适合安静地做事。"],
  ["user", "最近总是记不住待办。"], ["assistant", "写在固定的地方，每天早上过一遍会好很多。"],
  ["user", "给我讲个小笑话吧。"], ["assistant", "程序员去买菜，老板说一斤五块，他问能不能少一点，因为他想优化。"],
  ["user", "明天要早起，帮我想想怎么睡得好。"], ["assistant", "睡前少看屏幕，调暗灯光会有帮助。"],
  ["user", "我想学点新东西。"], ["assistant", "可以从你感兴趣、每天能抽出二十分钟的方向开始。"],
];

const LONG_BASE_TURNS = 160; // 约 3000 字，低于 6000 字的摘录预算
const hashId = (text) => {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return h >>> 0;
};

// 共享的 rand 消耗量与 longTurns 无关，所以改变 longTurns 不会改变后面的干扰会话，对照实验只差长会话本身。
// 多出来的填充句（longTurns 超过 160 的部分）由按会话独立的随机数生成，分到关键句前后。
function longSession(rand, needle, id, at, longTurns, seed) {
  const turns = [];
  const count = LONG_BASE_TURNS + Math.floor(rand() * 30);
  const pos = Math.floor(count * (0.3 + rand() * 0.4));
  for (let i = 0; i < count; i++) {
    if (i === pos) turns.push(["user", needle], ["assistant", "好的，我记下了。"]);
    else turns.push(CHATTER[Math.floor(rand() * CHATTER.length)]);
  }
  const extra = Math.max(0, longTurns - LONG_BASE_TURNS);
  let needleIndex = pos;
  if (extra > 0) {
    const own = mulberry32((seed ^ hashId(id)) >>> 0);
    const before = Math.floor(extra * (0.3 + own() * 0.4));
    const filler = (n) => Array.from({ length: n }, () => CHATTER[Math.floor(own() * CHATTER.length)]);
    turns.unshift(...filler(before));
    turns.push(...filler(extra - before));
    needleIndex += before;
  }
  return { ...session(id, at, turns), needleIndex };
}

// ── 干扰会话模板 ────────────────────────────────────────────────────────────
const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const DOMAINS = [
  { u: ["帮我看看这段 {lang} 代码为什么报错：{err}", "{lang} 里 {err} 一般是什么原因？"], a: ["{err} 常见原因是 {cause}，可以先检查 {fix}。"], s: { lang: ["Python", "Go", "Rust", "Java", "TypeScript"], err: ["空指针异常", "越界访问", "超时错误", "编码错误", "死锁"], cause: ["变量没有初始化", "并发访问没有加锁", "输入没有校验", "依赖版本不一致"], fix: ["调用栈", "日志里的第一条错误", "最近一次改动", "边界条件"] } },
  { u: ["晚饭想做 {dish}，有什么要注意的？", "{dish} 怎么做才不容易失败？"], a: ["{dish} 关键是 {tip}，火候不要太急。"], s: { dish: ["红烧排骨", "番茄炒蛋", "清蒸鲈鱼", "麻婆豆腐", "蒜蓉青菜"], tip: ["提前腌制", "控制水量", "最后再放盐", "油温适中"] } },
  { u: ["最近在健身，{part} 训练有什么建议？", "{part} 练完很酸，正常吗？"], a: ["{part} 训练要循序渐进，组间休息 {sec} 秒左右比较合适。"], s: { part: ["背部", "腿部", "肩部", "核心"], sec: ["六十", "九十", "一百二十"] } },
  { u: ["周末想去 {city} 玩，有什么推荐？", "{city} 有什么值得吃的东西？"], a: ["{city} 可以安排半天逛 {spot}，再留时间吃当地小吃。"], s: { city: ["西安", "厦门", "青岛", "大理", "洛阳"], spot: ["老街", "海边", "古城墙", "博物馆"] } },
  { u: ["我想买个 {item}，预算 {price} 左右。", "{item} 选哪个牌子比较靠谱？"], a: ["{price} 的预算可以看看口碑稳定的型号，别只看参数。"], s: { item: ["蓝牙耳机", "显示器", "行李箱", "电动牙刷", "保温杯"], price: ["三百", "五百", "一千", "两千"] } },
  { u: ["给我推荐一部 {genre} 电影吧。", "最近有什么好看的 {genre} 剧？"], a: ["{genre} 题材可以看看口碑不错的近年作品，节奏都比较紧凑。"], s: { genre: ["悬疑", "科幻", "喜剧", "纪实", "动画"] } },
  { u: ["帮我润色这句话：{sentence}", "这段话怎么改更自然：{sentence}"], a: ["可以改得更简洁一些，先说结论，再补原因。"], s: { sentence: ["我们这边觉得方案基本没有太大问题", "希望大家尽快给个反馈", "这个功能大概可能会稍微晚一点上线"] } },
  { u: ["{lang} 怎么做 {task}？", "有没有 {task} 的简单写法？"], a: ["{task} 可以用标准库完成，先写出最小可运行的版本再优化。"], s: { lang: ["Python", "Go", "JavaScript"], task: ["文件批量重命名", "读取表格数据", "定时执行脚本", "解析日志"] } },
  { u: ["最近睡眠不太好，有什么 {way}？", "{way} 对睡眠真的有帮助吗？"], a: ["{way} 需要坚持一段时间才能看到变化，不要急于求成。"], s: { way: ["调整办法", "放松练习", "饮食建议", "运动方式"] } },
  { u: ["我想养点绿植，{plant} 好养吗？", "{plant} 多久浇一次水？"], a: ["{plant} 比较耐养，见干见湿，放在有散射光的地方就行。"], s: { plant: ["绿萝", "龟背竹", "多肉", "虎皮兰"] } },
  { u: ["下周要做一次分享，主题是 {topic}。", "{topic} 的分享大纲怎么搭？"], a: ["可以按问题、方案、效果三段来写，每段配一个例子。"], s: { topic: ["团队协作", "代码评审", "效率工具", "数据可视化"] } },
  { u: ["帮我算一下 {n} 的 {pct}% 是多少？", "{n} 打 {off} 折是多少钱？"], a: ["按公式直接乘就行，我帮你算好了，注意四舍五入的位数。"], s: { n: ["一千二", "三百五", "两千八"], pct: ["七", "十五", "二十"], off: ["八", "七五", "九"] } },
  { u: ["最近想听点 {music}，有推荐吗？", "{music} 有哪些入门专辑？"], a: ["{music} 可以先从口碑经典的几张开始，找到喜欢的再深入。"], s: { music: ["爵士", "民谣", "古典", "电子", "摇滚"] } },
];

function fill(rand, template, slots) {
  return template.replace(/\{(\w+)\}/g, (_, key) => pick(rand, slots[key]));
}

function distractor(rand, id, at) {
  const domain = pick(rand, DOMAINS);
  const slots = {};
  for (const [k, list] of Object.entries(domain.s)) slots[k] = pick(rand, list);
  const rounds = 1 + Math.floor(rand() * 3);
  const turns = [];
  for (let i = 0; i < rounds; i++) {
    turns.push(["user", fill(rand, pick(rand, domain.u), Object.fromEntries(Object.entries(domain.s).map(([k, l]) => [k, pick(rand, l)])))]);
    turns.push(["assistant", fill(rand, pick(rand, domain.a), slots)]);
  }
  return session(id, at, turns);
}

/** 干扰会话和长会话的填充词里不得出现这些查询关键词。 */
export const FORBIDDEN_IN_FILLER = [...generatedKeys(), "咖啡", "拿铁", "薄荷", "闹钟", "香菜", "自行车", "橘猫", "团子", "猫砂", "日语", "N2", "Aurora", "林舟", "pnpm", "npm", "MU53", "青禾", "琥珀", "银色", "杭州", "成都", "云迁移", "护照", "备份", "机械键盘", "改日期", "读书计划", "红叶", "徒步"];

/** longTurns：长会话的目标轮数；0 或不超过 160 时与之前逐字节相同，更大时只给长会话补填充，其余会话不变。 */
export function buildDataset({ size = 120, seed = 20261013, longTurns = 0 } = {}) {
  const rand = mulberry32(seed);
  const hand = coreCases();
  const generated = generatedCases();
  const queries = [...hand.queries, ...generated.queries];
  const sessions = [...hand.sessions, ...generated.sessions].map((s) => (s.needle ? longSession(rand, s.needle, s.id, s.at, longTurns, seed) : s));
  let i = 0;
  while (sessions.length < size) {
    const n = String(++i).padStart(4, "0");
    sessions.push(distractor(rand, `d-${n}`, daysAgo(1 + Math.floor(rand() * 60), 8 + Math.floor(rand() * 12))));
  }
  return { now: NOW, sessions, queries };
}

export function sessionText(s) {
  return s.turns.map((t) => t.text).join("\n");
}

/** 干扰会话和长会话的填充句不能含有查询关键词，否则标准答案就不再唯一。 */
export function assertNoLeakage(dataset) {
  const chatter = new Set(CHATTER.map((c) => c[1]));
  for (const s of dataset.sessions) {
    let body = null;
    if (s.id.startsWith("d-")) body = sessionText(s);
    else if (s.id.startsWith("s-long-") || s.id.startsWith("g-n")) {
      // 只检查填充句；关键句本来就包含查询词。
      body = s.turns.filter((t) => chatter.has(t.text)).map((t) => t.text).join("\n");
      if (s.turns.length < 100) throw new Error(`长会话 ${s.id} 太短`);
    }
    if (body === null) continue;
    for (const word of FORBIDDEN_IN_FILLER) {
      if (body.includes(word)) throw new Error(`${s.id} 的填充含有关键词 ${word}`);
    }
  }
  const ids = new Set(dataset.sessions.map((s) => s.id));
  if (ids.size !== dataset.sessions.length) throw new Error("会话 id 重复");
  for (const query of dataset.queries) {
    for (const g of query.gold) if (!ids.has(g)) throw new Error(`${query.id} 的标准答案 ${g} 不存在`);
    if (query.newer && !ids.has(query.newer)) throw new Error(`${query.id} 缺少 newer`);
    if (query.older && !ids.has(query.older)) throw new Error(`${query.id} 缺少 older`);
  }
}
