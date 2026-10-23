import { describe, expect, it } from "vitest";
import { filterToolsForConversationMode } from "./harness-adapter";
import type { ToolDefinition } from "./tools/registry/tool-registry";

const catalog = ["read_file", "git_status", "git_init", "git_commit", "git_switch_branch", "git_push", "git_revert", "search_code"].map(id => ({
  id, name: `Action ${id}`, enabled: true, description: "Fixture action", inputSchema: { type: "object", properties: {} }, execute: async () => "Observed",
}) satisfies ToolDefinition);

describe("Git tool visibility by conversation mode", () => {
  it.each(["chat", "work", "learn", undefined])("withholds all Git operations from %s while retaining ordinary tool order", mode => {
    const before = [...catalog];
    expect(filterToolsForConversationMode(mode as never, catalog).map(tool => tool.id)).toEqual(["read_file", "search_code"]);
    expect(catalog).toEqual(before);
  });

  it("preserves the complete catalog in Code, including all Git actions in their original order", () => {
    expect(filterToolsForConversationMode("code", catalog).map(tool => tool.id)).toEqual([
      "read_file", "git_status", "git_init", "git_commit", "git_switch_branch", "git_push", "git_revert", "search_code",
    ]);
  });
});
