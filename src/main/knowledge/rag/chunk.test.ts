import { expect, it } from "vitest";
import { iterateDocumentChunks, chunkText } from "./chunk";

it("preserves the document ending when the last window is too short", () => {
  const document = "cedar birch maple spruce willow ash elm pine oak fir yew larch";
  expect(chunkText(document, "tree-guide", 6, 2).at(-1)?.text).toContain("yew larch");
});
it("offers identical ordered chunks through its eager and iterable APIs", () => {
  const document = "# Orchard\napples pears plums cherries peaches apricots figs dates";
  const streamed = [...iterateDocumentChunks(document, "orchard", 6, 2)];
  expect(streamed).toEqual(chunkText(document, "orchard", 6, 2));
  expect(streamed.map(chunk => [chunk.id, chunk.source, chunk.index]))
    .toEqual(streamed.map((_, index) => [`orchard_${index}`, "orchard", index]));
});
