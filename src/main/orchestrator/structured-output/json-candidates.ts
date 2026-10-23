export type JsonCandidateMethod = "scan" | "fence" | "direct";
export type JsonCandidate = {
  method: JsonCandidateMethod;
  value: Record<string, unknown>;
  raw: string;
};

function objectRecord(input: unknown): input is Record<string, unknown> {
  return Boolean(input) && typeof input === "object" && !Array.isArray(input);
}

function orderedJson(input: unknown): string {
  if (Array.isArray(input)) return "[" + input.map(orderedJson).join(",") + "]";
  if (!objectRecord(input)) return JSON.stringify(input);
  const entries = Object.keys(input).sort().map((name) => JSON.stringify(name) + ":" + orderedJson(input[name]));
  return "{" + entries.join(",") + "}";
}

function objectSlices(source: string): string[] {
  const slices: string[] = [];
  let opening = -1;
  let nesting = 0;
  let quoted = false;
  let slash = false;
  for (let cursor = 0; cursor < source.length; cursor++) {
    const token = source[cursor];
    if (quoted) {
      if (slash) slash = false;
      else if (token === "\\") slash = true;
      else if (token === '"') quoted = false;
    } else if (token === '"') {
      quoted = true;
    } else if (token === "{") {
      if (nesting === 0) opening = cursor;
      nesting++;
    } else if (token === "}" && nesting > 0) {
      nesting--;
      if (nesting === 0 && opening >= 0) {
        slices.push(source.slice(opening, cursor + 1));
        opening = -1;
      }
    }
  }
  return slices;
}

export function extractJsonCandidates(text: string): JsonCandidate[] {
  if (!text?.trim()) return [];
  const proposals: Array<{ raw: string; method: JsonCandidateMethod }> = [];
  proposals.push({ raw: text.trim(), method: "direct" });
  for (const fenced of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    proposals.push({ raw: fenced[1].trim(), method: "fence" });
  }
  objectSlices(text).forEach((raw) => proposals.push({ raw, method: "scan" }));
  const accepted = new Map<string, JsonCandidate>();
  for (const proposal of proposals) {
    let decoded: unknown;
    try { decoded = JSON.parse(proposal.raw); }
    catch { continue; }
    if (!objectRecord(decoded)) continue;
    const identity = orderedJson(decoded);
    if (accepted.has(identity)) continue;
    accepted.set(identity, { ...proposal, value: decoded });
  }
  return Array.from(accepted.values());
}
