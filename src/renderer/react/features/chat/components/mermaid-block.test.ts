// @vitest-environment jsdom
import { expect, test } from "vitest";
import { renderMermaidSafe } from "./MermaidBlock";

test.each([
  "flowchart LR\nInput[入口] --> Output[出口]",
  "sequenceDiagram\nClient->>Server: Request\nServer-->>Client: Reply",
  "stateDiagram-v2\nIdle --> Busy",
  "classDiagram\nVehicle <|-- Bicycle",
  "erDiagram\nAUTHOR ||--o{ BOOK : writes",
])("produces sanitized themed SVG for %s", (source) => {
  const result = renderMermaidSafe(source);
  expect(result.kind).toBe("svg");
  if (result.kind !== "svg") throw new Error("Expected a rendered diagram");
  expect(result.svg).toContain("<svg");
  expect(result.svg).not.toContain("fonts.googleapis.com");
  expect(result.svg).not.toMatch(/<script/i);
  if (source.startsWith("flowchart")) {
    expect(result.svg).toContain("入口");
    for (const token of ["var(--ff-diagram-accent)", "var(--ff-diagram-node)"]) expect(result.svg).toContain(token);
    expect(result.svg).not.toMatch(/#e8a0b4|#fffafc|#d9b8c4/);
  }
});

test.each(["mindmap\nroot((unsupported))", "invalid diagram syntax!"])("returns an error result for %s", (source) => {
  expect(renderMermaidSafe(source)).toStrictEqual({ kind: "error" });
});

test("rejects oversized diagrams before attempting to render them", () => {
  const source = "graph LR\n" + Array.from({ length: 1700 }, (_, index) =>
    `Step${index}[Task ${index}] --> Step${index + 1}`).join("\n");
  expect(renderMermaidSafe(source)).toStrictEqual({ kind: "fuse" });
});
