/**
 * <think> 标签的流式过滤，位于 AG-UI 事件桥，避免思维链标签泄漏到可见文本。
 *
 * 模式：
 * - "strict"：过滤全文所有 <think>...</think> 块
 * - "leading-only"：仅当消息开头（忽略空白）就是 <think> 时才过滤，
 *   否则全部透传，防止误删正文或代码块里提到的 <think>
 * - "disabled"：完全透传
 *
 * 生命周期以单条 assistant message 为界（TEXT_MESSAGE_START ~ TEXT_MESSAGE_END），
 * 不跨整个 run；函数调用循环里每次 LLM 调用都有独立边界。
 */

export type ThinkFilterMode = "strict" | "leading-only" | "disabled";

export interface ThinkStreamFilter {
  /** 推入一个 chunk，返回过滤后的可见文本（可能为空字符串）。 */
  push(chunk: string): string;
  /** 消息结束时 flush 残留的可见文本（可能为空字符串）。 */
  flush(): string;
  /** 取出自上次读取后捕获到的公开 <think> 文本。 */
  takeThinking(): string;
}

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

/** 全量过滤器：跨 chunk 记住状态，能处理被拆开的标签。 */
function createStrictFilter(): ThinkStreamFilter {
  let carry = "";
  let inThink = false;
  let captured = "";

  /** 末尾可能是标签前缀的部分需要留到下个 chunk。 */
  const safePrefix = (tag: string): number => Math.max(0, carry.length - (tag.length - 1));

  return {
    push(chunk: string): string {
      carry += chunk;
      let shown = "";

      while (carry.length > 0) {
        const folded = carry.toLowerCase();

        if (inThink) {
          const end = folded.indexOf(CLOSE_TAG);
          if (end === -1) {
            const cut = safePrefix(CLOSE_TAG);
            captured += carry.slice(0, cut);
            carry = carry.slice(cut);
            break;
          }
          captured += carry.slice(0, end);
          carry = carry.slice(end + CLOSE_TAG.length);
          inThink = false;
          continue;
        }

        const start = folded.indexOf(OPEN_TAG);
        if (start === -1) {
          const cut = safePrefix(OPEN_TAG);
          shown += carry.slice(0, cut);
          carry = carry.slice(cut);
          break;
        }
        shown += carry.slice(0, start);
        carry = carry.slice(start + OPEN_TAG.length);
        inThink = true;
      }

      return shown;
    },

    flush(): string {
      if (inThink) {
        // 未闭合的 <think> 不进正文，但仍作为已公开的思考过程保留
        captured += carry;
        carry = "";
        return "";
      }
      const rest = carry;
      carry = "";
      return rest;
    },

    takeThinking(): string {
      const out = captured;
      captured = "";
      return out;
    },
  };
}

/**
 * leading-only 过滤器：先缓冲，直到能判断消息是否以 <think> 开头；
 * 是则交给 strict 过滤器，否则此后全部透传。
 */
function createLeadingOnlyFilter(): ThinkStreamFilter {
  let phase: "buffering" | "filtering" | "passthrough" = "buffering";
  let held = "";
  const strict = createStrictFilter();

  const release = (): string => {
    phase = "passthrough";
    const text = held;
    held = "";
    return text;
  };

  return {
    push(chunk: string): string {
      if (phase === "passthrough") return chunk;
      if (phase === "filtering") return strict.push(chunk);

      held += chunk;
      const head = held.trimStart();
      const opensThink = head.toLowerCase().startsWith(OPEN_TAG);

      if (opensThink) {
        phase = "filtering";
        const shown = strict.push(held);
        held = "";
        return shown;
      }
      // 首个非空白字符不是 "<"，或者已凑够标签长度仍不匹配
      if (head.length > 0 && !head.startsWith("<")) return release();
      if (head.length >= OPEN_TAG.length) return release();
      return "";
    },

    flush(): string {
      if (phase === "passthrough") return "";
      if (phase === "buffering") return release();
      return strict.flush();
    },

    takeThinking(): string {
      return phase === "filtering" ? strict.takeThinking() : "";
    },
  };
}

/** 按模式创建 <think> 流式过滤器，默认 leading-only（最稳妥）。 */
export function createThinkFilter(mode: ThinkFilterMode = "leading-only"): ThinkStreamFilter {
  switch (mode) {
    case "disabled":
      return { push: (s: string) => s, flush: () => "", takeThinking: () => "" };
    case "strict":
      return createStrictFilter();
    default:
      return createLeadingOnlyFilter();
  }
}

/** 非流式场景一次性剥离 <think> 块；未闭合 <think> 之后的内容一并丢弃。 */
export function stripThinkBlocks(text: string): string {
  const closedRemoved = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  return closedRemoved.replace(/<think>[\s\S]*$/gi, "").trim();
}
