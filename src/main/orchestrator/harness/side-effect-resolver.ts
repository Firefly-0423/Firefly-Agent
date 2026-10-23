import type { ToolDefinition } from "../tools/registry/tool-registry";
import { resolveEffectKind } from "../tools/registry/tool-registry";
import type { SideEffectKind } from "./types";

const effectLabels: Record<string, SideEffectKind> = {
  read: "read_only", verification: "read_only", mutation: "idempotent_mutation",
  external_side_effect: "non_idempotent_side_effect", unknown: "non_idempotent_side_effect",
};
export function resolveSideEffect(tool: ToolDefinition | undefined, args: Record<string, unknown>): SideEffectKind {
  const resolved = resolveEffectKind(tool, args);
  return effectLabels[resolved] ?? "non_idempotent_side_effect";
}
