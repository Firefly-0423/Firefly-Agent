// 记忆关系图的数据：你 → 类别 → 记忆（已记住 / 待确认）→ 来源对话；项目范围的记忆再连到项目。纯函数，不碰 DOM。
import type { MemoryPanelState } from "../../../shared/memory-panel-contracts";
import { memoryGraphCategory } from "../../../shared/memory-graph-categories";

export type MemoryGraphNodeKind = "self" | "category" | "fact" | "candidate" | "source" | "project";
export interface MemoryGraphNode {
  id: string;
  kind: MemoryGraphNodeKind;
  label: string;
  /** factId or candidateId, so a click can open the same card as the list. */
  itemId?: string;
  /** Category key ("language", …, "other") of a category, fact or candidate node, for its colour. */
  category?: string;
}
export interface MemoryGraphLink { source: string; target: string; kind: "category" | "item" | "source" | "project" }
export interface MemoryGraphModel { nodes: MemoryGraphNode[]; links: MemoryGraphLink[] }


/** The graph node of a project-scoped item's project: its opaque `projectRef` when Main sent one, else its name. */
export function projectNodeId(item: { projectRef?: string; projectName?: string }): string {
  return `project:${item.projectRef ?? item.projectName}`;
}

/** `label(key)` turns a category id ("language", …, "other") or "self" into display text. */
export function buildMemoryGraph(state: MemoryPanelState, label: (key: string) => string): MemoryGraphModel {
  const nodes = new Map<string, MemoryGraphNode>(), links: MemoryGraphLink[] = [];
  const add = (node: MemoryGraphNode) => { if (!nodes.has(node.id)) nodes.set(node.id, node); return node.id; };
  const self = add({ id: "self", kind: "self", label: label("self") });
  const categoryOf = memoryGraphCategory;
  const category = (key: string) => {
    const id = `category:${key}`;
    if (!nodes.has(id)) { add({ id, kind: "category", label: label(key), category: key }); links.push({ source: self, target: id, kind: "category" }); }
    return id;
  };
  const surroundings = (item: string, from: { sourceRef: { binding?: { sessionId: string } }; sourceTitle?: string; scope?: string; projectRef?: string; projectName?: string }) => {
    const session = from.sourceRef.binding?.sessionId;
    if (session) {
      const id = `source:${session}`;
      add({ id, kind: "source", label: from.sourceTitle ?? label("untitled") });
      links.push({ source: item, target: id, kind: "source" });
    }
    if (from.scope === "project" && from.projectName) {
      // Two projects can share a folder name: the node is keyed by the project's identity, the name is only its label.
      const id = projectNodeId(from);
      add({ id, kind: "project", label: from.projectName });
      links.push({ source: item, target: id, kind: "project" });
    }
  };
  for (const fact of state.facts) {
    const key = categoryOf(fact.attribute), parent = category(key), id = add({ id: `fact:${fact.factId}`, kind: "fact", label: fact.assertion, itemId: fact.factId, category: key });
    links.push({ source: parent, target: id, kind: "item" });
    surroundings(id, fact);
  }
  for (const candidate of state.candidates) {
    const key = categoryOf(candidate.attribute), parent = category(key), id = add({ id: `candidate:${candidate.candidateId}`, kind: "candidate", label: candidate.assertion, itemId: candidate.candidateId, category: key });
    links.push({ source: parent, target: id, kind: "item" });
    surroundings(id, candidate);
  }
  return { nodes: [...nodes.values()], links };
}
