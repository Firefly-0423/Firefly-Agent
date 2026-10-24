import { expect, it } from "vitest";
import { smartPunctuate } from "./smart-punctuation";

const type = (text: string) => [...text].reduce((draft, char) => smartPunctuate(draft, draft + char), "");

it("formats dashes, ellipses, arrows and comparisons as they are typed", () => {
  expect(type("a--b")).toBe("a—b");
  expect(type("wait...")).toBe("wait…");
  expect(type("x -> y <- z => w")).toBe("x → y ← z ⇒ w");
  expect(type("1 <= 2 >= 0 != 3")).toBe("1 ≤ 2 ≥ 0 ≠ 3");
});
it("curls quotes by position", () => {
  expect(type('say "hi" and \'yo\'')).toBe("say “hi” and ‘yo’");
  expect(type("it's")).toBe("it’s");
});
it("leaves code, pastes and edits in the middle alone", () => {
  expect(type("`a -> b` ok")).toBe("`a -> b` ok");
  expect(smartPunctuate("abc", "a--bc")).toBe("a--bc");
  expect(smartPunctuate("", "pasted -> text")).toBe("pasted -> text");
});
