import { describe, it, expect } from "vitest";
import type { ToolDefinition } from "./tools/registry/tool-registry";
import type { AskUserAnswer } from "../../shared/ask-clarification";
import { createPendingAction, buildPendingAskInput, resolvePendingActionAnswers } from "./ask-answer-resolver";

function exportTool(): ToolDefinition {
  return { id: "export_agenda", capability: "agenda.export", name: "Export agenda", description: "Create a calendar handout", enabled: true, effectKind: "mutation", verificationPolicy: "artifact",
    inputSchema: { type: "object", properties: {
      heading: { type: "string" }, encoding: { type: "string", enum: ["ical", "html", "text"] }, quantity: { type: "integer" },
    }, required: ["heading", "encoding", "quantity"] }, execute: async () => "not executed",
  };
}
const coordinates = { runId: "agenda-run", planId: "agenda-plan", stepId: "export-step", stepAttemptId: "export-attempt" };
function pending(tool: ToolDefinition, missingFields = ["encoding", "quantity"], argumentsSnapshot: Record<string, unknown> = { heading: "Weekly schedule" }) {
  return createPendingAction({ tool, capability: "agenda.export", objective: "Export a weekly calendar", targetRefs: [], afterSuccess: "respond", argumentsSnapshot, missingFields, context: coordinates, createdAt: 640 });
}
function solve(tool: ToolDefinition, action: ReturnType<typeof pending>, answers: AskUserAnswer["answers"], currentContext = coordinates) {
  return resolvePendingActionAnswers({ pendingAction: action, currentTool: tool, answer: { requestId: "agenda-question", answers }, currentContext, toolResults: [] });
}

describe("Runtime-owned action parameter clarification", () => {
  it("derives ordered enum choices and primitive bindings from the tool schema", () => {
    const tool = exportTool(), action = pending(tool);
    expect(action.bindings).toStrictEqual({ encoding: "encoding", quantity: "quantity" });
    expect(buildPendingAskInput(action, tool, "Print the calendar")).toEqual({
      userRequest: "Print the calendar", missingFields: [
        expect.objectContaining({ field: "encoding", typeHint: "single_select", allowedOptions: [{ label: "ical", value: "ical" }, { label: "html", value: "html" }, { label: "text", value: "text" }] }),
        expect.objectContaining({ field: "quantity", typeHint: "text", allowedOptions: undefined }),
      ],
    });
    expect(solve(tool, action, [{ field: "quantity", customText: "4" }, { field: "encoding", selectedValues: ["html"] }])).toEqual({
      kind: "resume_action", action: expect.objectContaining({ toolId: "export_agenda", args: { heading: "Weekly schedule", quantity: 4, encoding: "html" } }),
    });
  });

  it("returns unrecognized semantics to the agent and recognizes only declared aliases", () => {
    const tool = exportTool();
    tool.inputSchema.properties.encoding = { type: "string", enum: ["ical", "html", "text"], askAliases: { Calendar: "ical", Webpage: "html" } };
    const action = pending(tool, ["encoding"], { heading: "Weekly schedule", quantity: 4 });
    expect(solve(tool, action, [{ field: "encoding", customText: "Make something attractive" }])).toMatchObject({ kind: "return_to_agent", reason: "normalization_failed" });
    expect(solve(tool, action, [{ field: "encoding", customText: "  cAlEnDaR  " }])).toEqual({
      kind: "resume_action", action: expect.objectContaining({ args: { heading: "Weekly schedule", quantity: 4, encoding: "ical" } }),
    });
  });

  it("refuses stale execution coordinates and changed schemas before resuming", () => {
    const tool = exportTool(), action = pending(tool, ["encoding"], { heading: "Weekly schedule", quantity: 4 });
    const answers = [{ field: "encoding", selectedValues: ["html"] }];
    expect(solve(tool, action, answers, { ...coordinates, runId: "another-run" })).toMatchObject({ kind: "return_to_agent", reason: "stale_pending_action" });
    const changed = exportTool();
    changed.inputSchema.properties.encoding = { type: "string", enum: ["csv", "text"] };
    expect(solve(changed, action, answers)).toMatchObject({ kind: "return_to_agent", reason: "schema_validation_failed" });
  });

  it("rejects nonexistent fields and object bindings", () => {
    const tool = exportTool();
    tool.inputSchema.properties.preferences = { type: "object", properties: { audience: { type: "string" } }, required: ["audience"] };
    tool.inputSchema.required!.push("preferences");
    expect(() => pending(tool, ["encoding", "unknownSetting"], {})).toThrow("E_PENDING_ACTION_BINDING_INVALID");
    expect(() => pending(tool, ["preferences"], {})).toThrow("E_PENDING_ACTION_BINDING_UNSUPPORTED");
  });
});
