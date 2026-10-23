function normalizeLine(source: string): string[] {
  const spaced = source.replace(/^(#{1,6})(?=[^#\s])/, "$1 ");
  if (spaced.startsWith("#")) {
    const stop = spaced.indexOf("。");
    if (stop > 0) {
      const paragraph = spaced.slice(stop + 1).trim();
      if (paragraph.length >= 2) return [spaced.slice(0, stop), "", paragraph];
    }
  }
  return [spaced];
}

export function normalizeModelMarkdown(input: string): string {
  if (!input.includes("#") && !input.includes("```")) return input;
  let fenced = false;
  const rendered = input.split("\n").flatMap((source) => {
    if (/^ {0,3}(`{3,}|~{3,})/.test(source)) {
      fenced = !fenced;
      return [source];
    }
    if (fenced) return [source];
    const attached = source.match(/(\S)(`{3})(\w+)\s*$/);
    if (!attached) return normalizeLine(source);
    const boundary = source.length - attached[0].length + 1;
    return [source.slice(0, boundary), "", source.slice(boundary)];
  });
  return rendered.join("\n");
}
