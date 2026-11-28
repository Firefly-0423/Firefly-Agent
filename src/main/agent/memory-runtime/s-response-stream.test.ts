import { expect, it, vi } from "vitest";
import { consumeSResponseStream } from "./s-response-stream";
function events(text = "hi") {
  const part = (text: string) => ({ type: "output_text", text, annotations: [] });
  const item = (complete: boolean) => ({ id: "item", type: "message", role: "assistant", status: complete ? "completed" : "in_progress", content: complete ? [part(text)] : [] });
  const anchor = { item_id: "item", output_index: 0, content_index: 0 };
  return [
    { type: "response.created", response: { id: "r", status: "in_progress", output: [] } },
    { type: "response.in_progress", response: { id: "r", status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: item(false) },
    { type: "response.content_part.added", ...anchor, part: part("") },
    { type: "response.output_text.delta", ...anchor, delta: "" },
    { type: "response.output_text.delta", ...anchor, delta: text },
    { type: "response.output_text.done", ...anchor, text },
    { type: "response.content_part.done", ...anchor, part: part(text) },
    { type: "response.output_item.done", output_index: 0, item: item(true) },
    { type: "response.completed", response: { id: "r", status: "completed", output: [item(true)] } },
  ].map((event, sequence_number) => ({ ...event, sequence_number }));
}
function fixture(values: unknown[] = events()) {
  const controller = new AbortController(), returned = vi.fn(async () => ({ done: true as const, value: undefined }));
  let cursor = 0; const stream = { controller, [Symbol.asyncIterator]: () => ({ next: async () => cursor < values.length ? { done: false, value: values[cursor++] } : { done: true, value: undefined }, return: returned }) };
  const order: string[] = [], target = { assistantTurnId: "a", isCurrent: vi.fn(() => true), onEvent: vi.fn((event: any) => order.push(event.type)) };
  const input = { stream, target: target as never, validate: vi.fn(async () => {}), commit: vi.fn(async () => { order.push("commit"); }), afterCommit: vi.fn(() => order.push("afterCommit")) };
  return { input, target, order, controller, returned };
}
it("streams nonempty deltas once, commits only after terminal EOF and emits ordered completion", async () => {
  const f = fixture(); expect(await consumeSResponseStream(f.input)).toEqual({ reply: "hi", toolResults: [], completionReason: "no_tool", terminal: { status: "success", externalEffectsMayContinue: false } });
  expect(f.order).toEqual(["step_started", "text_message_start", "text_message_content", "commit", "afterCommit", "text_message_end", "step_finished"]);
  expect(f.input.commit).toHaveBeenCalledExactlyOnceWith("hi"); expect(f.returned).not.toHaveBeenCalled(); expect(f.controller.signal.aborted).toBe(false);
});
it("allows creation to proceed directly to the output item", async () => {
  const values = events().filter((_, i) => i !== 1); const f = fixture(values); expect((await consumeSResponseStream(f.input)).reply).toBe("hi");
});
it.each([null, {}, []])("rejects non-iterable stream %j", async stream => { const f = fixture(); await expect(consumeSResponseStream({ ...f.input, stream })).rejects.toThrow(/^MEMORY_CONTEXT_STREAM_INVALID$/); });
it.each(["response.failed", "error", "response.incomplete", "unsupported"])("rejects %s and aborts without committing", async type => {
  const f = fixture([{ type, sequence_number: 0 }]); const code = type === "response.incomplete" ? "MEMORY_CONTEXT_STREAM_INCOMPLETE" : type === "unsupported" ? "MEMORY_CONTEXT_STREAM_INVALID" : "MEMORY_CONTEXT_STREAM_SERVER_ERROR";
  await expect(consumeSResponseStream(f.input)).rejects.toThrow(new RegExp(`^${code}$`)); expect(f.input.commit).not.toHaveBeenCalled(); expect(f.controller.signal.aborted).toBe(true); expect(f.returned).toHaveBeenCalledOnce();
});
it.each([
  (v: any[]) => { v[1].sequence_number = 0; },
  (v: any[]) => { v[0].sequence_number = -1; },
  (v: any[]) => { v[5].item_id = "other"; },
  (v: any[]) => { v[5].output_index = 1; },
  (v: any[]) => { v[6].text = "different"; },
  (v: any[]) => { v[9].response.id = "other"; },
  (v: any[]) => { v.push({ type: "error", sequence_number: 10 }); },
  (v: any[]) => { v.pop(); },
])("rejects invalid sequence/anchors/completion %#", async mutate => {
  const values = events(); mutate(values); const f = fixture(values); await expect(consumeSResponseStream(f.input)).rejects.toThrow(/^MEMORY_CONTEXT_STREAM_INVALID$/); expect(f.input.commit).not.toHaveBeenCalled();
});
it.each(["tool", "annotation", "unknown"])("rejects unsupported %s output", async kind => {
  const values: any[] = events(); if (kind === "tool") values[2].item.type = "function_call"; else if (kind === "annotation") values[3].part.annotations = [{}]; else values[4].type = "unknown";
  await expect(consumeSResponseStream(fixture(values).input)).rejects.toThrow(/^MEMORY_CONTEXT_STREAM_OUTPUT_UNSUPPORTED$/);
});
it("rejects whitespace-only completed output", async () => { await expect(consumeSResponseStream(fixture(events(" ")).input)).rejects.toThrow(/^MEMORY_CONTEXT_STREAM_INVALID$/); });
it("rejects stale targets before forwarding content", async () => { const f = fixture(); f.target.isCurrent.mockReturnValue(false); await expect(consumeSResponseStream(f.input)).rejects.toThrow(/^MEMORY_CONTEXT_RUN_STALE$/); expect(f.order).toEqual(["step_started"]); });
it("checks cancellation again after validation", async () => {
  const f = fixture(), abort = new AbortController(); f.input.validate.mockImplementation(async () => abort.abort()); await expect(consumeSResponseStream({ ...f.input, signal: abort.signal })).rejects.toThrow(/^MEMORY_CONTEXT_CANCELLED$/);
});
it("checks cancellation after commit before settlement", async () => {
  const f = fixture(), abort = new AbortController(); f.input.commit.mockImplementation(async () => { abort.abort(); }); await expect(consumeSResponseStream({ ...f.input, signal: abort.signal })).rejects.toThrow(/^MEMORY_CONTEXT_CANCELLED$/); expect(f.input.afterCommit).not.toHaveBeenCalled();
});
it("maps unexpected iterator errors to a safe failure code", async () => {
  const f = fixture(); const stream = { [Symbol.asyncIterator]: () => ({ next: async () => { throw Error("private"); } }) }; await expect(consumeSResponseStream({ ...f.input, stream })).rejects.toThrow(/^MEMORY_CONTEXT_STREAM_FAILED$/);
});
it("rejects pre-aborted input without consuming events", async () => {
  const f = fixture(), abort = new AbortController(); abort.abort();
  await expect(consumeSResponseStream({ ...f.input, signal: abort.signal })).rejects.toThrow(/^MEMORY_CONTEXT_CANCELLED$/);
  expect(f.input.validate).not.toHaveBeenCalled();
  expect(f.returned).toHaveBeenCalledOnce();
});
it("aborts a blocked iterator and calls its return method on cancellation", async () => {
  const f = fixture(), abort = new AbortController(), next = vi.fn(() => new Promise<IteratorResult<unknown>>(() => {}));
  const stream = { controller: f.controller, [Symbol.asyncIterator]: () => ({ next, return: f.returned }) };
  const pending = consumeSResponseStream({ ...f.input, stream, signal: abort.signal });
  const assertion = expect(pending).rejects.toThrow(/^MEMORY_CONTEXT_CANCELLED$/);
  await Promise.resolve(); abort.abort(); await assertion;
  expect(next).toHaveBeenCalledOnce(); expect(f.controller.signal.aborted).toBe(true); expect(f.returned).toHaveBeenCalledOnce();
});
it("rechecks the target after validation and preserves safe validation error codes", async () => {
  const f = fixture(); f.input.validate.mockImplementation(async () => { f.target.isCurrent.mockReturnValue(false); });
  await expect(consumeSResponseStream(f.input)).rejects.toThrow(/^MEMORY_CONTEXT_RUN_STALE$/);
  const other = fixture(); other.input.validate.mockRejectedValue(Error("MEMORY_CONTEXT_SOURCE_STALE"));
  await expect(consumeSResponseStream(other.input)).rejects.toThrow(/^MEMORY_CONTEXT_SOURCE_STALE$/);
});
it("rejects output exceeding the UTF-8 byte limit", async () => {
  const values: any[] = events(); values[5].delta = "a".repeat(8 * 1024 * 1024 + 1);
  const f = fixture(values);
  await expect(consumeSResponseStream(f.input)).rejects.toThrow(/^MEMORY_CONTEXT_STREAM_INVALID$/);
  expect(f.input.commit).not.toHaveBeenCalled();
});
