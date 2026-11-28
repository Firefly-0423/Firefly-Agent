/**
 * 把聊天内容压缩成适合表情包语义匹配的纯文本。
 *
 * 表情包只该反映对话的情绪与意图；代码和数学公式会给向量带来大量无关 token，
 * 所以在送去 embedding 之前直接删掉，不做解释或转写。
 * 只需要决定保留什么、删掉什么，用正则比完整解析 Markdown 更轻，也省去依赖。
 */
export function extractStickerEmbeddingText(source: string): string {
  if (!source.trim()) return "";

  // 按顺序依次应用，顺序会影响结果
  const steps: Array<[RegExp, string]> = [
    // 围栏代码块，两种 Markdown 围栏写法
    [/(?:^|\n)[ \t]*```[\s\S]*?```[ \t]*(?=\n|$)/g, "\n"],
    [/(?:^|\n)[ \t]*~~~[\s\S]*?~~~[ \t]*(?=\n|$)/g, "\n"],
    // 块级与行内 TeX 公式
    [/\$\$[\s\S]*?\$\$/g, " "],
    [/\\\[[\s\S]*?\\\]/g, " "],
    [/\\\([\s\S]*?\\\)/g, " "],
    [/\$(?:\\.|[^$\r\n])+\$/g, " "],
    // 行内代码
    [/`[^`\n]*`/g, " "],
    // HTML 标签：去掉尖括号标记，保留里面的文字
    [/<\/?[a-zA-Z][^>]*>/g, " "],
    // 图片语法整体删除（alt 多半是文件名，不含情绪）
    [/!\[[^\]]*\]\([^)]*\)/g, " "],
    // 链接只留文字，去掉对向量无益的 URL
    [/\]\([^)]*\)/g, "]"],
    // 助手输出的显式表情包标记
    [/\[sticker:[^\]]+\]/gi, " "],
    // 各类空白合并为单个空格
    [/\s+/g, " "],
  ];

  return steps.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), source).trim();
}

/** 构造发往 embedding 的查询：回复与用户输入各自提取文本后拼接，并限制长度 */
export function buildStickerEmbeddingQuery(reply: string, userText: string, maxLength = 1000): string {
  const parts = [reply, userText].map(extractStickerEmbeddingText).filter(Boolean);
  return parts.join("\n").slice(0, maxLength);
}
