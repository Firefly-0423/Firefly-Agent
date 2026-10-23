import { it, expect } from "vitest";
import { filterToolsForTask } from "./tool-filter";
import type { ScheduledTask } from "./types";
import type { ToolDefinition } from "../orchestrator/tools/registry/tool-registry";

it("filters disabled tools before applying the task allow list and preserves registry order", () => {
  const definitions = ["lookup_plant", "edit_garden", "check_rain"].map((id, index): ToolDefinition => ({
    id, enabled: index !== 1, name: id, description: "Garden action",
    inputSchema: { properties: {}, type: "object" }, execute: async () => "done",
  }));
  const job: ScheduledTask = {
    id: "garden-job", title: "Garden reminder", prompt: "Check the garden", enabled: true,
    schedule: { kind: "daily", timeOfDay: "09:45" }, nextFireAt: "2026-10-21T09:45:00.000Z",
    createdAt: "2026-10-20T02:00:00.000Z", updatedAt: "2026-10-20T02:00:00.000Z",
    toolMode: "allow-list", allowedToolIds: ["edit_garden", "check_rain", "absent_tool"],
  };
  expect(filterToolsForTask(job, definitions)).toEqual([definitions[2]]);
  expect(filterToolsForTask({ ...job, toolMode: "all-enabled" }, definitions)).toEqual([definitions[0], definitions[2]]);
});
