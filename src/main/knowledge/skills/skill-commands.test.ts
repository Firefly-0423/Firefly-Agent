import { describe, expect, it } from "vitest";
import { parseSlashCommand as recognize } from "./skill-commands";

describe("Skill slash dispatch", () => {
  const available = ["summarize-notes", "review-patch", "7-day-plan"];

  it.each([
    ["/summarize-notes", "summarize-notes"],
    ["/review-patch examine the staged changes", "review-patch"],
    ["/summarize-notes 请整理今天的笔记", "summarize-notes"],
    ["/7-day-plan\tMonday", "7-day-plan"],
    ["/review-patch\nsecond line", "review-patch"],
  ])("selects the complete leading token in %j", (message, id) => {
    expect(recognize(message, available)).toStrictEqual({ skillId: id, hit: true });
  });

  it.each([
    "/commands", "/missing-capability", "Please summarize this",
    "/../../private/keys", "/Review_Patch", "/ summarize-notes",
    "//summarize-notes", "/summarize-notes/followup", " /review-patch",
    "/review-patch.extra", "/review-patch_more", "", "/",
  ])("passes through an input that is not an available skill token: %j", (message) => {
    expect(recognize(message, available)).toStrictEqual({ hit: false });
  });

  it("cannot dispatch a syntactically valid command when no skills are available", () => {
    expect(recognize("/summarize-notes", [])).toStrictEqual({ hit: false });
  });
});