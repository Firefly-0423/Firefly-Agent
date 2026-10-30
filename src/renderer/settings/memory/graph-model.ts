// 记忆关系图的数据：你 → 类别 → 记忆（已记住 / 待确认）→ 来源对话；项目范围的记忆再连到项目。纯函数，不碰 DOM。
import type { MemoryPanelState } from "../../../shared/memory-panel-contracts";

export type MemoryGraphNodeKind = "self" | "category" | "fact" | "candidate" | "source" | "project";
export interface MemoryGraphNode {
  id: string;
  kind: MemoryGraphNodeKind;
  label: string;
  /** factId or candidateId, so a click can open the same card as the list. */
  itemId?: string;
}
export interface MemoryGraphLink { source: string; target: string; kind: "category" | "item" | "source" | "project" }
export interface MemoryGraphModel { nodes: MemoryGraphNode[]; links: MemoryGraphLink[] }

const KNOWN_CATEGORIES = new Set(["language", "response-style", "shell", "address", "tool", "preference"]);

/** `label(key)` turns a category id ("language", …, "other") or "self" into display text. */
export function buildMemoryGraph(state: MemoryPanelState, label: (key: string) => string): MemoryGraphModel {
  const nodes = new Map<string, MemoryGraphNode>(), links: MemoryGraphLink[] = [];
  const add = (node: MemoryGraphNode) => { if (!nodes.has(node.id)) nodes.set(node.id, node); return node.id; };
  const self = add({ id: "self", kind: "self", label: label("self") });
  const category = (attribute: string | undefined) => {
    const key = attribute && KNOWN_CATEGORIES.has(attribute) ? attribute : "other";
    const id = `category:${key}`;
    if (!nodes.has(id)) { add({ id, kind: "category", label: label(key) }); links.push({ source: self, target: id, kind: "category" }); }
    return id;
  };
  const surroundings = (item: string, from: { sourceRef: { binding?: { sessionId: string } }; sourceTitle?: string; scope?: string; projectName?: string }) => {
    const session = from.sourceRef.binding?.sessionId;
    if (session) {
      const id = `source:${session}`;
      add({ id, kind: "source", label: from.sourceTitle ?? label("untitled") });
      links.push({ source: item, target: id, kind: "source" });
    }
    if (from.scope === "project" && from.projectName) {
      const id = `project:${from.projectName}`;
      add({ id, kind: "project", label: from.projectName });
      links.push({ source: item, target: id, kind: "project" });
    }
  };
  for (const fact of state.facts) {
    const parent = category(fact.attribute), id = add({ id: `fact:${fact.factId}`, kind: "fact", label: fact.assertion, itemId: fact.factId });
    links.push({ source: parent, target: id, kind: "item" });
    surroundings(id, fact);
  }
  for (const candidate of state.candidates) {
    const parent = category(candidate.attribute), id = add({ id: `candidate:${candidate.candidateId}`, kind: "candidate", label: candidate.assertion, itemId: candidate.candidateId });
    links.push({ source: parent, target: id, kind: "item" });
    surroundings(id, candidate);
  }
  return { nodes: [...nodes.values()], links };
}
