import { describe, expect, it, vi } from "vitest";
import { resolveStructuredOutputProfile } from "./profiles";
import { runStructuredOutput, type StructuredGenerationResponse, type StructuredOutputRunInput, type StructuredRepairContext } from "./runner";

type Route = { route: string };
function scenario(...responses: (StructuredGenerationResponse | Error)[]) {
  const pending = [...responses];
  const generate = vi.fn(async () => {
    const response = pending.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error("Unexpected generation");
    return response;
  });
  const buildRequest = vi.fn((repair: StructuredRepairContext) => ({ iteration: repair.attempt, compact: repair.minimal }));
  const parseSchema = vi.fn((candidate: unknown): Route => {
    const route = (candidate as Route)?.route;
    if (typeof route !== "string") throw new Error("route must be a string");
    return { route };
  });
  const input: StructuredOutputRunInput<Route, { iteration: number; compact: boolean }> = {
    stage: "task_router", profile: resolveStructuredOutputProfile({ provider: "minimax", model: "MiniMax-M3", transport: "openai", endpointKind: "official" }),
    buildRequest, generate, parseSchema, validateBusiness: value => ({ status: "accepted", value }),
  };
  return { input, generate, buildRequest, parseSchema };
}
const answer = (route: string): StructuredGenerationResponse => ({ text: JSON.stringify({ route }), finishReason: "stop" });

describe("Validated structured response execution", () => {
  it("returns a unique accepted route with no repairs", async () => {
    const { input, generate } = scenario(answer("summarize"));
    expect(await runStructuredOutput(input)).toEqual({ outcome: "success", value: { route: "summarize" }, attempts: 1, repairCount: 0, mode: "prompt_json" });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("validates a pre-parsed object even when response text cannot yield JSON", async () => {
    const { input, parseSchema } = scenario({ text: "Opaque provider response", structuredValue: { route: "inspect" }, finishReason: "stop" });
    expect(await runStructuredOutput(input)).toMatchObject({ outcome: "success", value: { route: "inspect" }, attempts: 1 });
    expect(parseSchema).toHaveBeenCalledExactlyOnceWith({ route: "inspect" });
  });

  it("requests repair for ambiguity instead of selecting one of two schema-valid objects", async () => {
    const { input, buildRequest } = scenario({ text: '{"route":"inspect"}\n{"route":"clarify"}', finishReason: "stop" }, answer("clarify"));
    expect(await runStructuredOutput(input)).toMatchObject({ outcome: "success", value: { route: "clarify" }, attempts: 2, repairCount: 1 });
    expect(buildRequest.mock.calls[1][0].errors).toEqual([{ code: "AMBIGUOUS_MULTIPLE_VALID_OBJECTS", layer: "schema", disposition: "repair" }]);
  });

  it("uses the third generation's minimal request after truncation and malformed JSON", async () => {
    const { input, generate, buildRequest } = scenario({ text: '{"route":', finishReason: "length" }, { text: "Malformed answer", finishReason: "stop" }, answer("inspect"));
    expect((await runStructuredOutput(input)).outcome).toEqual("success");
    expect(generate.mock.calls.map(call => (call as unknown[])[0])).toEqual([
      { iteration: 0, compact: false }, { iteration: 1, compact: false }, { iteration: 2, compact: true },
    ]);
    expect(buildRequest.mock.calls.map(([context]) => context.errors)).toEqual([
      [], [{ code: "TRUNCATED_OUTPUT", layer: "format", disposition: "repair" }], [{ code: "NO_JSON_OBJECT", layer: "format", disposition: "repair" }],
    ]);
  });

  it("returns business rejection without attempting protocol repair", async () => {
    const { input, generate } = scenario(answer("execute"));
    input.validateBusiness = () => ({ status: "rejected", error: { code: "STATE_EXPIRED", layer: "business", disposition: "refresh_state" } });
    expect(await runStructuredOutput(input)).toEqual({ outcome: "failure", failure: { stage: "task_router", attempts: 1, code: "STATE_EXPIRED", disposition: "refresh_state", toolExecuted: false } });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ text: "", finishReason: "content_filter" }, "CONTENT_FILTERED"],
    [{ text: "", finishReason: "stop", refusal: "Cannot comply" }, "REFUSED"],
    [new Error("Transport unreachable"), "MODEL_REQUEST_FAILED"],
    [{ text: "", finishReason: "tool_calls" }, "UNEXPECTED_TOOL_CALL"],
    [{ text: "", finishReason: "unrecognized" }, "UNKNOWN_FINISH_REASON"],
  ] as const)("fails closed for %j with code %s and no further requests", async (response, code) => {
    const { input, generate } = scenario(response);
    expect(await runStructuredOutput(input)).toEqual({ outcome: "failure", failure: { stage: "task_router", attempts: 1, code, disposition: "fail_closed", toolExecuted: false } });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("exhausts exactly two repair requests before returning an explicit closed failure", async () => {
    const { input, generate } = scenario(...["Invalid A", "Invalid B", "Invalid C"].map(text => ({ text, finishReason: "stop" })));
    expect(await runStructuredOutput(input)).toEqual({ outcome: "failure", failure: { stage: "task_router", attempts: 3, code: "REPAIR_EXHAUSTED", disposition: "fail_closed", toolExecuted: false } });
    expect(generate).toHaveBeenCalledTimes(3);
  });
});
