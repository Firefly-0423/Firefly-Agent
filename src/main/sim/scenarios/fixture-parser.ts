import type { WorldbookEntry } from "../../rag/worldbook";

type FixtureRecord = { heading: string; attributes: Map<string, string>; paragraphs: string[] };
function decodeRecord(source: string): FixtureRecord {
  const record: FixtureRecord = { heading: "", attributes: new Map(), paragraphs: [] };
  let inAttributes = true;
  for (const originalLine of source.split("\n")) {
    const trimmedLine = originalLine.trim();
    if (record.heading === "" && trimmedLine.startsWith("## ")) {
      record.heading = trimmedLine.replace(/^## /, "").trim();
      continue;
    }
    if (inAttributes && trimmedLine.startsWith("- ")) {
      const pair = trimmedLine.match(/^- ([^:：]+)[：:]\s*(.*)$/);
      if (pair) record.attributes.set(pair[1].trim(), pair[2].trim());
      continue;
    }
    if (inAttributes && trimmedLine === "") {
      if (record.heading !== "" && record.attributes.size > 0) inAttributes = false;
      continue;
    }
    if (!inAttributes) record.paragraphs.push(originalLine);
  }
  return record;
}

export function parseFixtureMarkdown(content: string, fileName: string): WorldbookEntry[] {
  const entries: WorldbookEntry[] = [];
  for (const source of content.split(/^---$/m)) {
    const record = decodeRecord(source);
    if (!record.heading || record.paragraphs.join("").trim() === "") continue;
    const attribute = (key: string) => record.attributes.get(key);
    const triggers = (attribute("触发词") ?? "").split(/[,，、]/).map((word) => word.trim()).filter(Boolean);
    const score = attribute("内在价值") ?? attribute("初始分") ?? attribute("initial_score") ?? attribute("intrinsic_value") ?? "60";
    entries.push({
      id: `wb_${fileName}_${record.heading.replace(/\s+/g, "_")}`,
      keywords: triggers,
      content: record.paragraphs.join("\n").trim(),
      priority: parseInt(attribute("优先级") ?? "5") || 5,
      permanent: ["是", "yes", "true"].includes(attribute("常驻") ?? ""),
      enabled: true,
      intrinsicValue: parseFloat(score) || 60,
      linkTriggers: [],
    });
  }
  return entries;
}
