import type { SocialAtom } from "./types";

export function compileSocialContextBlock(atoms: readonly SocialAtom[]): string {
  if (atoms.length === 0) return "";
  const previous = atoms.filter((fact) => fact.type !== "open_loop").slice(0, 5);
  const unfinished = atoms.filter((fact) => fact.type === "open_loop").slice(0, 5);
  const lines = [
    "【本轮可用的对话背景】",
    "只在确实相关时自然使用；不要复述这份背景，不要展示或强调你具有记忆能力。",
  ];
  for (const [heading, items] of [["相关的过去：", previous], ["尚未接上的话题：", unfinished]] as const) {
    if (items.length === 0) continue;
    lines.push(heading, ...items.map((fact) => `- ${fact.content}`));
  }
  return lines.join("\n");
}
