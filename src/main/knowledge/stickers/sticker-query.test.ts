import { it, expect } from "vitest";
import { extractStickerEmbeddingText as prose, buildStickerEmbeddingQuery as query } from "./sticker-query";

it("strips program text, formulas and link destinations while retaining prose and markdown labels", () => {
  const markdown = "## A calm evening\n```js\nalert('hidden')\n```\nInline `secret()` stays hidden.\nA formula $r=7$ and a block:\n$$x+y=z$$\n[Guide](https://docs.invalid/private)";
  expect(prose(markdown)).toBe("## A calm evening Inline stays hidden. A formula and a block: [Guide]");
});
it("joins sanitized assistant and user prose with a newline", () => {
  const response = "Let us rest.\n```ruby\nputs 'private'\n```\n\\[a+b\\]";
  expect(query(response, "Please explain $q^2$ afterwards.")).toBe("Let us rest.\nPlease explain afterwards.");
});
