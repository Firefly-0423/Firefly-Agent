import type { ToolDefinition } from "./tool-registry";

function catalogPurpose(definition: ToolDefinition): string {
  if (definition.catalogHint && definition.catalogHint.trim()) return definition.catalogHint.trim();
  const heading = (definition.description ?? "").split("\n")[0]?.trim();
  return heading || (definition.description ?? "").trim();
}

export function buildToolCatalog(definitions: ReadonlyArray<ToolDefinition>): string {
  if (!definitions.length) return "（当前没有可用工具）";
  const entries = definitions.map(definition => {
    const purpose = catalogPurpose(definition);
    const level = definition.risk ?? "safe";
    return `- ${definition.id}\n  用途：${purpose}\n  风险：${level}`;
  });
  return entries.join("\n");
}
