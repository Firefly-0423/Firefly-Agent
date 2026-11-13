// 把一份会话拆成"几轮一个窗口"的词法排序单元。
// 整段会话做一个检索单元时，长会话里的一句话会被篇幅稀释；评测显示窗口化让这一类从 0%–8% 升到 67%–100%。
// 这里只产生用于排序的文本，不改变存储、证据或授权：命中后返回的仍是完整文档。
export interface WindowSource {text: string}

/** 相邻 `turns` 条消息一个窗口，不重叠。`turns <= 0` 或消息数不超过一个窗口时返回 null，表示不拆分。 */
export function toWindows(messages: ReadonlyArray<WindowSource>, turns: number): Array<{text: string}> | null {
  if (!Number.isSafeInteger(turns) || turns <= 0 || messages.length <= turns) return null;
  const out: Array<{text: string}> = [];
  for (let i = 0; i < messages.length; i += turns) {
    out.push({text: messages.slice(i, i + turns).map((m) => m.text).join('\n')});
  }
  return out;
}
