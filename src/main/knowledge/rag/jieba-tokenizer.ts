export interface TokenInfo {
  word: string;
  tag: string;       // 词性标注：n/ns/nr/v/a/d/p/c/u 等
  isStop: boolean;   // 是否为停用词/高频词
  isNoun: boolean;   // 是否为名词或专名
}

// ── 常用停用词（~120 个高频无意义字/词） ──
const STOP_WORDS = new Set([
  "的", "了", "是", "在", "我", "你", "他", "她", "它",
  "有", "不", "也", "就", "都", "这", "那", "还", "要",
  "和", "与", "或", "但", "而", "且", "及", "之", "为",
  "上", "下", "中", "里", "外", "前", "后", "左", "右",
  "到", "去", "来", "从", "把", "被", "让", "给", "对",
  "吗", "呢", "吧", "啊", "嘛", "哦", "嗯", "呀", "哇",
  "很", "太", "更", "最", "非", "没", "将", "已", "能",
  "会", "可", "以", "好", "多", "少", "大", "小", "真",
  "个", "些", "点", "样", "种", "些", "哪", "谁", "什",
  "做", "当", "看", "听", "说", "想", "觉", "知", "道",
  "过", "完", "着", "住", "得", "地", "于", "其", "该",
  "我们", "你们", "他们", "她们", "它们",
  "自己", "什么", "怎么", "为什么", "因为", "所以",
  "这个", "那个", "这些", "那些", "这里", "那里",
  "一个", "一种", "一些", "的话", "时候", "地方",
  "东西", "事情", "问题", "就是", "可以", "但是",
  "没有", "不要", "不是", "不会", "不能", "应该",
  "已经", "可能", "觉得", "知道", "告诉",
]);

// 非名词/非动词的常见虚词性标签（BM25 应降权处理）
const STOP_TAGS = new Set(["u", "c", "p", "d", "r", "y", "o", "e", "m", "q", "f"]);
// 名词性标签（需加权）
const NOUN_TAGS = new Set(["n", "nr", "ns", "nt", "nz", "ng", "vn", "an"]);

/** 停用词降权系数 */
const STOP_WEIGHT = 0.3;
/** 名词加权系数 */
const NOUN_WEIGHT = 1.3;

function mergeCustomWords(tokens: string[], customWords: ReadonlySet<string>): string[] {
  if (customWords.size === 0 || tokens.length < 2) return tokens;

  // 按长度倒序排序，优先匹配长词（避免"流萤小助手"被错误合并成"流萤小助手"）
  const sortedWords = [...customWords].sort((a, b) => b.length - a.length);

  // 用"窗口匹配"扫描：找到第一个能匹配的位置，合并若干个 token 为一个词
  const result: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    let matched = false;
    for (const word of sortedWords) {
      const wordTokens = word.split(""); // 单字数组
      // 检查从 i 开始的连续 token 是否能拼成 word
      let ok = true;
      for (let j = 0; j < wordTokens.length; j++) {
        if (i + j >= tokens.length || tokens[i + j] !== wordTokens[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        result.push(word);
        i += wordTokens.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      result.push(tokens[i]);
      i++;
    }
  }
  return result;
}

export function tokenizeJieba(text: string, jieba: {cut(text:string,hmm:boolean):string[];tag(text:string,hmm:boolean):{word:string;tag:string}[]}, customWords: ReadonlySet<string>): TokenInfo[] {
  // 纯英文/数字文本走原来的空格分词逻辑（jieba 不适合纯英文）
  if (/^[a-zA-Z0-9\s]+$/.test(text)) {
    return text.split(/\s+/).filter(Boolean).map((word) => ({
      word: word.toLowerCase(),
      tag: "eng",
      isStop: false,
      isNoun: false,
    }));
  }

  try {
    // 第二个参数 hmm=true 让 jieba 用 HMM 模型识别未登录词（如角色名"流萤"）
    // 默认词典不含"流萤"等角色名，但 HMM 能根据上下文判断这是个整体
    // 再叠加后处理：把 jieba 切散的自定义词重组
    const rawCuts = jieba.cut(text, true);
    const mergedCuts = mergeCustomWords(rawCuts, customWords);

    // 用 jieba.tag 给重组后的词打标签（每个"词"独立 tag）
    // 重组后词和原文本不对齐，所以对每个 merged token 单独 tag
    const result: TokenInfo[] = [];
    for (const word of mergedCuts) {
      const tagged = jieba.tag(word, true);
      const first = tagged[0] ?? { word, tag: "x" };
      result.push({
        word: word.toLowerCase(),
        tag: first.tag,
        isStop: STOP_WORDS.has(word) || STOP_TAGS.has(first.tag),
        isNoun: NOUN_TAGS.has(first.tag),
      });
    }
    return result;
  } catch {
    // jieba 失败时回退到单字切分
    const tokens: TokenInfo[] = [];
    const seg = text.split(/([\u4e00-\u9fff]|[a-zA-Z]+|\d+)/).filter(Boolean);
    for (const s of seg) {
      if (/[\u4e00-\u9fff]/.test(s)) {
        for (const c of s) {
          tokens.push({ word: c, tag: "x", isStop: STOP_WORDS.has(c), isNoun: false });
        }
      } else {
        tokens.push({ word: s.toLowerCase(), tag: "eng", isStop: false, isNoun: false });
      }
    }
    return tokens;
  }
}
