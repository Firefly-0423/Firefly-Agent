import { expect, it } from "vitest";
import { buildMemoryGraph } from "./graph-model";
import type { MemoryPanelState } from "../../../shared/memory-panel-contracts";

const binding = (sessionId: string) => ({ providerId: "firefly", sessionId, messageId: "m", contentRevision: 1, generation: 0 });
const fact = (factId: string, assertion: string, extra: object) => ({ factId, revision: 1, subjectKey: "k", assertion, assertionKind: "user-statement",
  time: { validFrom: null, validTo: null, referenceTime: 1 }, sourceRef: { sourceId: "s-" + factId, revision: 1 }, recordedAt: 1, acceptedAt: 1, supersededAt: null,
  activationReason: "policyAccepted", policyVersion: "t", provenance: { candidateId: null, evidenceId: null, activationSourceRef: { sourceId: "a", revision: 1 } }, ...extra });

it("draws you, the categories in use, each memory, its conversation and its project", () => {
  const state = {
    facts: [
      fact("f1", "请用中文回复", { attribute: "language", sourceRef: { sourceId: "s1", revision: 1, binding: binding("chat-1") }, sourceTitle: "周末聊天", scope: "global" }),
      fact("f2", "我默认用 bash", { attribute: "shell", sourceRef: { sourceId: "s2", revision: 1, binding: binding("chat-1") }, scope: "project", projectName: "alpha" }),
      fact("f3", "未分类", { sourceRef: { sourceId: "s3", revision: 1 } }),
      fact("f4", "常用 TypeScript", { attribute: "programming-usage", sourceRef: { sourceId: "s5", revision: 1 } }),
    ],
    candidates: [{ reviewState: "ready", candidateId: "c1", revision: 1, attribute: "unclassified", value: null, assertion: "我喜欢茶", reason: "r",
      sourceRef: { sourceId: "s4", revision: 1, binding: binding("chat-2") } }],
    backendStatus: { available: true }, coverage: {},
  } as unknown as MemoryPanelState;
  const model = buildMemoryGraph(state, key => `<${key}>`);
  expect(model.nodes.map(node => [node.id, node.kind, node.label])).toEqual([
    ["self", "self", "<self>"],
    ["category:language", "category", "<language>"], ["fact:f1", "fact", "请用中文回复"], ["source:chat-1", "source", "周末聊天"],
    ["category:shell", "category", "<shell>"], ["fact:f2", "fact", "我默认用 bash"], ["project:alpha", "project", "alpha"],
    ["category:other", "category", "<other>"], ["fact:f3", "fact", "未分类"],
    ["category:programming-usage", "category", "<programming-usage>"], ["fact:f4", "fact", "常用 TypeScript"],
    ["candidate:c1", "candidate", "我喜欢茶"], ["source:chat-2", "source", "<untitled>"],
  ]);
  // One conversation node shared by both memories learned there; unknown categories fold into "other".
  expect(model.links.filter(link => link.target === "source:chat-1").map(link => link.source)).toEqual(["fact:f1", "fact:f2"]);
  expect(model.links).toContainEqual({ source: "category:other", target: "candidate:c1", kind: "item" });
  expect(model.nodes.find(node => node.id === "fact:f2")).toMatchObject({ itemId: "f2", category: "shell" });
  expect(model.nodes.find(node => node.id === "candidate:c1")?.category).toBe("other");
});

it("is just you when nothing is remembered", () => {
  expect(buildMemoryGraph({ facts: [], candidates: [], backendStatus: { available: true } } as unknown as MemoryPanelState, key => key)).toEqual({ nodes: [{ id: "self", kind: "self", label: "self" }], links: [] });
});
