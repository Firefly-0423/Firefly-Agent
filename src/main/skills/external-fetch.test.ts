import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXTERNAL_LIMITS } from "./external-policy";
import type { ExternalFetcher } from "./external-fetch";

const modules = import.meta.glob<typeof import("./external-fetch")>("./external-fetch.ts");
async function implementation() {
  const load = modules["./external-fetch.ts"];
  expect(load, "Main must implement bounded fixed-repository retrieval").toBeTypeOf("function");
  return load();
}
const commit = "a".repeat(40), treeSha = "b".repeat(40);
const base = "https://api.github.com/repos/openai/plugins";
const signal = () => new AbortController().signal;
const blobSha = (bytes: Buffer) => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
function blob(bytes: Buffer) { return { sha: blobSha(bytes), encoding: "base64", size: bytes.length, content: bytes.toString("base64") }; }
function injected(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: typeof globalThis.fetch = async (input, init = {}) => {
    const url = String(input); calls.push({ url, init }); return handler(url, init);
  };
  return { fetch, calls };
}
function streamed(text: string, chunk = 65536) {
  const bytes = Buffer.from(text); let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset >= bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.subarray(offset, offset += chunk));
  } }));
}
afterEach(() => vi.useRealTimers());

describe("fixed_repository_and_commit", () => {
  it("pins metadata, commit tree and blobs with credential-free manual-redirect requests", async () => {
    const { createExternalFetcher } = await implementation();
    const bytes = Buffer.from("synthetic instruction");
    const mock = injected(url => {
      if (url === base) return Response.json({ default_branch: "main" });
      if (url === base + "/commits/main") return Response.json({ sha: commit });
      if (url === base + "/git/commits/" + commit) return Response.json({ sha: commit, tree: { sha: treeSha } });
      if (url === base + "/git/trees/" + treeSha + "?recursive=1") return Response.json({ sha: treeSha, truncated: false, tree: [{ path: "skills/text/SKILL.md", mode: "100644", type: "blob", sha: blobSha(bytes), size: bytes.length }] });
      if (url === base + "/git/blobs/" + blobSha(bytes)) return Response.json(blob(bytes));
      throw new Error("Unexpected test request");
    });
    const fetcher = createExternalFetcher(mock.fetch);
    expect(await fetcher.resolveCommit("openai", signal())).toBe(commit);
    expect(await fetcher.readTree("openai", commit, signal())).toEqual({ commit, entries: [{ path: "skills/text/SKILL.md", mode: "100644", type: "blob", sha: blobSha(bytes), size: bytes.length }] });
    expect(await fetcher.readBlob("openai", blobSha(bytes), bytes.length, signal())).toEqual(bytes);
    expect(mock.calls.map(call => call.url)).toEqual([base, base + "/commits/main", base + "/git/commits/" + commit, base + "/git/trees/" + treeSha + "?recursive=1", base + "/git/blobs/" + blobSha(bytes)]);
    for (const { init } of mock.calls) {
      expect(init.credentials).toBe("omit"); expect(init.redirect).toBe("manual"); expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      const headers = new Headers(init.headers);
      expect(headers.has("authorization")).toBe(false); expect(headers.has("cookie")).toBe(false);
    }
  });
  it.each([301, 302, 307, 308])("rejects redirect %i without following", async status => {
    const { createExternalFetcher } = await implementation();
    const mock = injected(() => new Response(null, { status, headers: { location: "https://untrusted.example/next" } }));
    await expect(createExternalFetcher(mock.fetch).resolveCommit("openai", signal())).rejects.toMatchObject({ code: "NETWORK_FAILED" });
    expect(mock.calls).toHaveLength(1);
  });
  it.each(["https://user@api.github.com/repos/openai/plugins", "openai%2fplugins", "openai\\plugins", "openai#fragment", "../openai", "toString", "unknown"])("rejects invalid source %s before a request", async sourceId => {
    const { createExternalFetcher } = await implementation(); const mock = injected(() => Response.json({}));
    await expect(createExternalFetcher(mock.fetch).resolveCommit(sourceId as "openai", signal())).rejects.toMatchObject({ code: "SOURCE_INVALID" });
    expect(mock.calls).toHaveLength(0);
  });
  it.each(["a".repeat(39), "A".repeat(40), "../main", "https://user@api.github.com", "main%2fnext", "main\\next", "main#next"])("rejects noncanonical commit/blob %s before requesting", async value => {
    const { createExternalFetcher } = await implementation(); const mock = injected(() => Response.json({})); const fetcher = createExternalFetcher(mock.fetch);
    await expect(fetcher.readTree("openai", value, signal())).rejects.toMatchObject({ code: "TREE_INVALID" });
    await expect(fetcher.readBlob("openai", value, 1, signal())).rejects.toMatchObject({ code: "BLOB_MISMATCH" });
    expect(mock.calls).toHaveLength(0);
  });
  it.each(["../main", "main%2fother", "main\\other", "main#fragment", "https://user@host", "main/other"])("rejects ambiguous default branch %s", async default_branch => {
    const { createExternalFetcher } = await implementation(); const mock = injected(() => Response.json({ default_branch }));
    await expect(createExternalFetcher(mock.fetch).resolveCommit("openai", signal())).rejects.toMatchObject({ code: "CATALOG_INVALID" });
    expect(mock.calls).toHaveLength(1);
  });
  it("does not continue after an invalid resolved commit", async () => {
    const { createExternalFetcher } = await implementation(); const mock = injected(url => Response.json(url === base ? { default_branch: "main" } : { sha: "main" }));
    await expect(createExternalFetcher(mock.fetch).resolveCommit("openai", signal())).rejects.toMatchObject({ code: "CATALOG_INVALID" }); expect(mock.calls).toHaveLength(2);
  });
});

describe("bounded_streams_and_deadlines", () => {
  it.each([0, 1])("counts metadata bytes at catalog limit + %i without Content-Length", async excess => {
    const { createExternalFetcher } = await implementation(); const prefix = JSON.stringify({ default_branch: "main" });
    const payload = prefix + " ".repeat(EXTERNAL_LIMITS.catalogBytes - prefix.length + excess);
    const mock = injected(url => url === base ? streamed(payload) : Response.json({ sha: commit }));
    const promise = createExternalFetcher(mock.fetch).resolveCommit("openai", signal());
    if (excess) await expect(promise).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" }); else expect(await promise).toBe(commit);
  });
  it.each([0, 1])("counts tree metadata bytes at tree limit + %i", async excess => {
    const { createExternalFetcher } = await implementation(); const prefix = JSON.stringify({ sha: treeSha, truncated: false, tree: [] });
    const mock = injected(url => url.includes("/git/commits/") ? Response.json({ sha: commit, tree: { sha: treeSha } }) : streamed(prefix + " ".repeat(EXTERNAL_LIMITS.treeBytes - prefix.length + excess)));
    const promise = createExternalFetcher(mock.fetch).readTree("openai", commit, signal());
    if (excess) await expect(promise).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" }); else expect(await promise).toEqual({ commit, entries: [] });
  });
  it.each([32, 33])("enforces JSON nesting depth %i", async depth => {
    const { parseExternalJson } = await implementation(); const payload = "[".repeat(depth) + "0" + "]".repeat(depth);
    if (depth === 32) expect(parseExternalJson(Buffer.from(payload))).toBeDefined(); else expect(() => parseExternalJson(Buffer.from(payload))).toThrow(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
  });
  it("rejects malformed JSON and invalid UTF-8 deterministically", async () => {
    const { parseExternalJson } = await implementation();
    for (const bytes of [Buffer.from("{"), Buffer.from([0xff])]) expect(() => parseExternalJson(bytes)).toThrow(expect.objectContaining({ code: "CATALOG_INVALID" }));
  });
  it("distinguishes 429 and sanitized network errors", async () => {
    const { createExternalFetcher } = await implementation();
    await expect(createExternalFetcher(injected(() => new Response(null, { status: 429 })).fetch).resolveCommit("openai", signal())).rejects.toMatchObject({ code: "RATE_LIMITED", retryable: true });
    await expect(createExternalFetcher(injected(() => { throw new Error("secret/profile/upstream"); }).fetch).resolveCommit("openai", signal())).rejects.toMatchObject({ code: "NETWORK_FAILED", message: "External request failed.", retryable: true });
  });
  it("aborts a stalled fetch after exactly fifteen seconds", async () => {
    const { createExternalFetcher } = await implementation(); vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const mock = injected((_url, init) => { requestSignal = init.signal!; return new Promise<Response>(() => {}); });
    const promise = createExternalFetcher(mock.fetch).resolveCommit("openai", signal());
    const assertion = expect(promise).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(14999); expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await assertion; expect(requestSignal?.aborted).toBe(true);
  });
  it("keeps the deadline active while a response body stalls", async () => {
    const { createExternalFetcher } = await implementation(); vi.useFakeTimers();
    const mock = injected(() => new Response(new ReadableStream({ start() {} })));
    const assertion = expect(createExternalFetcher(mock.fetch).resolveCommit("openai", signal())).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(15000); await assertion;
  });
  it("honors cancellation without waiting for an ignoring fetch", async () => {
    const { createExternalFetcher } = await implementation(); const controller = new AbortController();
    const mock = injected(() => new Promise<Response>(() => {}));
    const assertion = expect(createExternalFetcher(mock.fetch).resolveCommit("openai", controller.signal)).rejects.toMatchObject({ code: "CANCELLED" });
    controller.abort(); await assertion;
  });
});

describe("tree_validation", () => {
  async function read(entries: unknown[], extra = {}) {
    const { createExternalFetcher } = await implementation(); const mock = injected(url => url.includes("/git/commits/") ? Response.json({ sha: commit, tree: { sha: treeSha } }) : Response.json({ sha: treeSha, tree: entries, truncated: false, ...extra }));
    return createExternalFetcher(mock.fetch).readTree("openai", commit, signal());
  }
  const entry = { path: "skills/text/SKILL.md", mode: "100644", type: "blob", sha: "c".repeat(40), size: 1 };
  it.each([50000, 50001])("enforces tree entry count %i", async count => {
    const entries = Array.from({ length: count }, (_, i) => ({ ...entry, path: `f${i}` }));
    if (count === 50000) expect((await read(entries)).entries).toHaveLength(count); else await expect(read(entries)).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });
  it("rejects a truncated tree", async () => { await expect(read([], { truncated: true })).rejects.toMatchObject({ code: "TREE_INVALID" }); });
  it.each([{ mode: "120000" }, { mode: "160000", type: "commit" }, { type: "special" }, { mode: "100600" }, { sha: "bad" }, { size: -1 }, { size: 1.1 }])("rejects unsupported tree entries %j", async change => { await expect(read([{ ...entry, ...change }])).rejects.toMatchObject({ code: "TREE_INVALID" }); });
  it.each(["/absolute", "../escape", "a/./b", "a/../b", "a\\b", "a%2fb", "a#b", "CON", "aux.txt", "dir/LPT1.md", "trailing.", "trailing ", "a//b", "a\u0000b"])("rejects invalid path %s", async path => { await expect(read([{ ...entry, path }])).rejects.toMatchObject({ code: "PATH_INVALID" }); });
  it("rejects duplicate and case-colliding paths including parent segments", async () => {
    for (const paths of [["a", "a"], ["a", "A"], ["dir/a", "DIR/b"]]) await expect(read(paths.map(path => ({ ...entry, path })))).rejects.toMatchObject({ code: "TREE_INVALID" });
  });
});

describe("blob_identity", () => {
  it.each([0, 1])("permits exactly one MiB decoded bytes, rejecting +%i", async excess => {
    const { createExternalFetcher } = await implementation(); const bytes = Buffer.alloc(EXTERNAL_LIMITS.fileBytes + excess, 97); const mock = injected(() => Response.json(blob(bytes)));
    const promise = createExternalFetcher(mock.fetch).readBlob("openai", blobSha(bytes), EXTERNAL_LIMITS.fileBytes, signal());
    if (excess) await expect(promise).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" }); else expect(await promise).toEqual(bytes);
  });
  it("uses the Git blob header and rejects mismatching declared SHA, size or bytes", async () => {
    const { createExternalFetcher } = await implementation(); const bytes = Buffer.from("hello");
    for (const response of [{ ...blob(bytes), sha: treeSha }, { ...blob(bytes), size: 4 }, blob(Buffer.from("other"))]) {
      const mock = injected(() => Response.json(response));
      await expect(createExternalFetcher(mock.fetch).readBlob("openai", blobSha(bytes), 10, signal())).rejects.toMatchObject({ code: "BLOB_MISMATCH" });
    }
  });
  it.each(["aGVsbG8", "aGVsbG8===", "aGV sbG8=", "aGVsbG9=", "%%%%", "aGVsbG8=\u0000"])("rejects corrupt or noncanonical base64 %s", async content => {
    const { createExternalFetcher } = await implementation(); const bytes = Buffer.from("hello"); const mock = injected(() => Response.json({ ...blob(bytes), content }));
    await expect(createExternalFetcher(mock.fetch).readBlob("openai", blobSha(bytes), 10, signal())).rejects.toMatchObject({ code: "BLOB_MISMATCH" });
  });
  it("accepts GitHub's line-wrapped base64 and preserves bytes for SHA-256", async () => {
    const { createExternalFetcher } = await implementation(); const bytes = Buffer.from("synthetic instruction"), encoded = bytes.toString("base64");
    const mock = injected(() => Response.json({ ...blob(bytes), content: encoded.slice(0, 8) + "\n" + encoded.slice(8) + "\n" }));
    const fetched = await createExternalFetcher(mock.fetch).readBlob("openai", blobSha(bytes), 100, signal());
    expect(createHash("sha256").update(fetched).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
});

describe("additional_identity_and_stream_guards", () => {
  it("rejects inconsistent commit and tree response identities before content reads", async () => {
    const { createExternalFetcher } = await implementation();
    for (const badCommit of [true, false]) {
      const mock = injected(url => url.includes("/git/commits/") ? Response.json({ sha: badCommit ? "c".repeat(40) : commit, tree: { sha: treeSha } }) : Response.json({ sha: "c".repeat(40), tree: [], truncated: false }));
      await expect(createExternalFetcher(mock.fetch).readTree("openai", commit, signal())).rejects.toMatchObject({ code: "TREE_INVALID" });
      expect(mock.calls).toHaveLength(badCommit ? 1 : 2);
    }
  });
  it("counts bytes even when Content-Length understates a streamed body", async () => {
    const { createExternalFetcher } = await implementation(); const response = streamed(" ".repeat(EXTERNAL_LIMITS.catalogBytes + 1)); response.headers.set("content-length", "1");
    const mock = injected(() => response);
    await expect(createExternalFetcher(mock.fetch).resolveCommit("openai", signal())).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });
  it("distinguishes GitHub 403 rate exhaustion and rejects a response moved to another URL", async () => {
    const { createExternalFetcher } = await implementation();
    await expect(createExternalFetcher(injected(() => new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "0" } })).fetch).resolveCommit("openai", signal())).rejects.toMatchObject({ code: "RATE_LIMITED" });
    const response = Response.json({ default_branch: "main" }); Object.defineProperty(response, "url", { value: "https://untrusted.example/result" });
    await expect(createExternalFetcher(injected(() => response).fetch).resolveCommit("openai", signal())).rejects.toMatchObject({ code: "NETWORK_FAILED" });
  });
  it("rejects a file used as a tree parent", async () => {
    const { createExternalFetcher } = await implementation(); const entries = ["a", "a/b"].map(path => ({ path, type: "blob", mode: "100644", sha: "c".repeat(40), size: 1 }));
    const mock = injected(url => url.includes("/git/commits/") ? Response.json({ sha: commit, tree: { sha: treeSha } }) : Response.json({ sha: treeSha, truncated: false, tree: entries }));
    await expect(createExternalFetcher(mock.fetch).readTree("openai", commit, signal())).rejects.toMatchObject({ code: "TREE_INVALID" });
  });
  it.each(["COM¹.txt", "LPT²", "COM³"])("rejects Windows superscript reserved device path %s", async path => {
    const { validateExternalPath } = await implementation();
    expect(() => validateExternalPath(path)).toThrow(expect.objectContaining({ code: "PATH_INVALID" }));
  });
  it.each([-1, NaN, Infinity, 0.5, EXTERNAL_LIMITS.fileBytes + 1])("rejects invalid decoded budget %s before fetch", async limit => {
    const { createExternalFetcher } = await implementation(); const mock = injected(() => Response.json({}));
    await expect(createExternalFetcher(mock.fetch).readBlob("openai", treeSha, limit, signal())).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" }); expect(mock.calls).toHaveLength(0);
  });
});

it.each([302, 429, 200])("cancels an unread response body after an early guard fails (status %i)", async status => {
  const { createExternalFetcher } = await implementation(); let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from("ignored")); }, cancel() { cancelled = true; } });
  const headers: HeadersInit = status === 200 ? { "content-length": String(EXTERNAL_LIMITS.catalogBytes + 1) } : {};
  const mock = injected(() => new Response(body, { status, headers }));
  await expect(createExternalFetcher(mock.fetch).resolveCommit("openai", signal())).rejects.toMatchObject({ code: status === 429 ? "RATE_LIMITED" : status === 200 ? "LIMIT_EXCEEDED" : "NETWORK_FAILED" });
  expect(cancelled).toBe(true);
});

describe("bounded_linear_tree_paths", () => {
  it.each([4096, 4097])("bounds a repository path at %i UTF-8 bytes", async bytes => {
    const { validateExternalPath } = await implementation();
    const path = "é".repeat(Math.floor(bytes / 2)) + (bytes % 2 ? "x" : "");
    expect(Buffer.byteLength(path, "utf8")).toBe(bytes);
    if (bytes === 4096) expect(validateExternalPath(path)).toBe(path);
    else expect(() => validateExternalPath(path)).toThrow(expect.objectContaining({ code: "PATH_INVALID" }));
  });
  it.each([64, 65])("bounds repository paths at %i segments using a small tree fixture", async count => {
    const { createExternalFetcher } = await implementation();
    const path = Array.from({ length: count }, (_, i) => `s${i}`).join("/");
    const mock = injected(url => url.includes("/git/commits/") ? Response.json({ sha: commit, tree: { sha: treeSha } }) : Response.json({ sha: treeSha, truncated: false, tree: [{ path, mode: "100644", type: "blob", sha: "c".repeat(40), size: 1 }] }));
    const promise = createExternalFetcher(mock.fetch).readTree("openai", commit, signal());
    if (count === 64) expect((await promise).entries[0].path).toBe(path);
    else await expect(promise).rejects.toMatchObject({ code: "PATH_INVALID" });
  });
  it("rejects the pathological 100000-segment path at the shared validator without entering the old tree expansion", async () => {
    const { validateExternalPath } = await implementation();
    // About 200 KiB only. Deliberately call the validator, never run quadratic tree work on this input.
    const path = Array(100000).fill("s").join("/");
    expect(() => validateExternalPath(path)).toThrow(expect.objectContaining({ code: "PATH_INVALID" }));
  });
  it("preserves sparse deep parent-segment case collision checks", async () => {
    const { createExternalFetcher } = await implementation();
    const parts = Array.from({ length: 63 }, (_, i) => `s${i}`), changed = [...parts]; changed[40] = changed[40].toUpperCase();
    const paths = [parts.join("/") + "/first", changed.join("/") + "/second"];
    const mock = injected(url => url.includes("/git/commits/") ? Response.json({ sha: commit, tree: { sha: treeSha } }) : Response.json({ sha: treeSha, truncated: false, tree: paths.map(path => ({ path, mode: "100644", type: "blob", sha: "c".repeat(40), size: 1 })) }));
    await expect(createExternalFetcher(mock.fetch).readTree("openai", commit, signal())).rejects.toMatchObject({ code: "TREE_INVALID" });
  });
  it.each([false, true])("preserves deep ancestor-file conflicts in either insertion order (reverse=%s)", async reverse => {
    const { createExternalFetcher } = await implementation(); const parent = Array.from({ length: 63 }, (_, i) => `s${i}`).join("/");
    const paths = [parent, parent + "/leaf"]; if (reverse) paths.reverse();
    const mock = injected(url => url.includes("/git/commits/") ? Response.json({ sha: commit, tree: { sha: treeSha } }) : Response.json({ sha: treeSha, truncated: false, tree: paths.map(path => ({ path, mode: "100644", type: "blob", sha: "c".repeat(40), size: 1 })) }));
    await expect(createExternalFetcher(mock.fetch).readTree("openai", commit, signal())).rejects.toMatchObject({ code: "TREE_INVALID" });
  });
  it("accepts an explicit deep tree parent after sparse descendant blobs", async () => {
    const { createExternalFetcher } = await implementation(); const parent = Array.from({ length: 63 }, (_, i) => `s${i}`).join("/");
    const entries = [{ path: parent + "/leaf", mode: "100644", type: "blob", sha: "c".repeat(40), size: 1 }, { path: parent, mode: "040000", type: "tree", sha: "d".repeat(40) }];
    const mock = injected(url => url.includes("/git/commits/") ? Response.json({ sha: commit, tree: { sha: treeSha } }) : Response.json({ sha: treeSha, truncated: false, tree: entries }));
    expect((await createExternalFetcher(mock.fetch).readTree("openai", commit, signal())).entries).toEqual(entries);
  });
});

describe("rate_deadlines_and_safe_diagnostics", () => {
  it.each([
    [{ "retry-after": "120" }, 121000],
    [{ "retry-after": "Thu, 01 Jan 1970 00:02:00 GMT" }, 120000],
    [{ "x-ratelimit-reset": "180" }, 180000],
    [{ "retry-after": "120", "x-ratelimit-reset": "180" }, 180000],
    [{}, 61000],
    [{ "retry-after": "-1", "x-ratelimit-reset": "invalid" }, 61000],
    [{ "retry-after": "99999999999999999999999999", "x-ratelimit-reset": "0" }, 61000],
  ])("returns a bounded, checked rate deadline for %j", async (headers, retryAt) => {
    const { createExternalFetcher } = await implementation();
    const mock = injected(() => new Response(null, { status: 429, headers }));
    await expect(createExternalFetcher(mock.fetch, { now: () => 1000 }).resolveCommit("openai", signal())).rejects.toMatchObject({ code: "RATE_LIMITED", retryAt });
  });
  it("diagnoses malformed metadata without recording its body, URL or header text", async () => {
    const { createExternalFetcher } = await implementation(), diagnostics: unknown[] = [];
    const sentinel = "secret-token userData-path credentials";
    const mock = injected(() => new Response(sentinel, { status: 200, headers: { "content-type": "text/html; x-secret=" + sentinel } }));
    await expect(createExternalFetcher(mock.fetch, { onDiagnostic: item => diagnostics.push(item) }).resolveCommit("anthropic", signal())).rejects.toMatchObject({ code: "CATALOG_INVALID" });
    expect(diagnostics).toEqual([{ sourceId: "anthropic", stage: "metadata", status: 200, contentType: "html", bytes: Buffer.byteLength(sentinel), errorClass: "ExternalFetchError", code: "CATALOG_INVALID", remaining: null, retryAfter: null, reset: null, serverTime: null }]);
    expect(JSON.stringify(diagnostics)).not.toContain(sentinel); expect(JSON.stringify(diagnostics)).not.toContain("https:");
  });
  it("diagnostic sink failure cannot replace the original business error", async () => {
    const { createExternalFetcher } = await implementation();
    const mock = injected(() => new Response("{", { status: 200 }));
    await expect(createExternalFetcher(mock.fetch, { onDiagnostic: () => { throw new Error("private diagnostic failure"); } }).resolveCommit("openai", signal())).rejects.toMatchObject({ code: "CATALOG_INVALID" });
  });
});

it.each([403, 429])("secondary_rate_limit %i honors Retry-After when the primary budget remains available", async status => {
  const { createExternalFetcher } = await implementation();
  const mock = injected(() => new Response(null, { status, headers: { "retry-after": "120", "x-ratelimit-remaining": "42", "x-ratelimit-reset": "3600" } }));
  await expect(createExternalFetcher(mock.fetch, { now: () => 1000 }).resolveCommit("openai", signal())).rejects.toMatchObject({ code: "RATE_LIMITED", retryAt: 121000 });
});
it("secondary_rate_limit malformed Retry-After uses a bounded fallback rather than an unexhausted primary reset", async () => {
  const { createExternalFetcher } = await implementation();
  const mock = injected(() => new Response(null, { status: 403, headers: { "retry-after": "invalid", "x-ratelimit-remaining": "42", "x-ratelimit-reset": "3600" } }));
  await expect(createExternalFetcher(mock.fetch, { now: () => 1000 }).resolveCommit("openai", signal())).rejects.toMatchObject({ code: "RATE_LIMITED", retryAt: 61000 });
});
it("secondary_rate_limit ordinary forbidden response with remaining budget stays a network failure", async () => {
  const { createExternalFetcher } = await implementation();
  const mock = injected(() => new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "42", "x-ratelimit-reset": "3600" } }));
  await expect(createExternalFetcher(mock.fetch, { now: () => 1000 }).resolveCommit("openai", signal())).rejects.toMatchObject({ code: "NETWORK_FAILED", retryAt: undefined });
});

it.each([
  [{ date: "Thu, 01 Jan 1970 00:10:00 GMT", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "720" }, { remaining: 0, retryAfter: null, reset: 720000, serverTime: 600000, retryAt: 121000, deadlineSource: "reset" }],
  [{ date: "Thu, 01 Jan 1970 00:10:00 GMT", "retry-after": "120", "x-ratelimit-remaining": "42", "x-ratelimit-reset": "3600" }, { remaining: 42, retryAfter: 720000, reset: 3600000, serverTime: 600000, retryAt: 121000, deadlineSource: "retry-after" }],
  [{ date: "Thu, 01 Jan 1970 00:10:00 GMT", "retry-after": "Thu, 01 Jan 1970 00:12:00 GMT" }, { retryAfter: 720000, serverTime: 600000, retryAt: 121000, deadlineSource: "retry-after" }],
])("normalized_rate_diagnostics project validated server-clock deadlines to the local clock: %j", async (headers, expected) => {
  const { createExternalFetcher } = await implementation(), diagnostics: unknown[] = [];
  const mock = injected(() => new Response(null, { status: 429, headers }));
  await expect(createExternalFetcher(mock.fetch, { now: () => 1000, onDiagnostic: item => diagnostics.push(item) }).resolveCommit("openai", signal())).rejects.toMatchObject({ code: "RATE_LIMITED", retryAt: 121000 });
  expect(diagnostics).toEqual([expect.objectContaining({ stage: "metadata", status: 429, bytes: 0, ...expected })]);
  for (const item of Object.values(diagnostics[0] as object)) if (typeof item === "number") expect(Number.isSafeInteger(item)).toBe(true);
});
it("normalized_rate_diagnostics reject raw secrets and malformed date/numeric headers without inventing a server deadline", async () => {
  const { createExternalFetcher } = await implementation(), diagnostics: unknown[] = [];
  const secret = "private-token private-profile-path";
  const mock = injected(() => new Response(secret, { status: 429, headers: { date: secret, "retry-after": secret, "x-ratelimit-reset": "99999999999999999999", "x-ratelimit-remaining": secret } }));
  await expect(createExternalFetcher(mock.fetch, { now: () => 1000, onDiagnostic: item => diagnostics.push(item) }).resolveCommit("openai", signal())).rejects.toMatchObject({ code: "RATE_LIMITED", retryAt: 61000 });
  expect(diagnostics).toEqual([expect.objectContaining({ remaining: null, retryAfter: null, reset: null, serverTime: null, retryAt: 61000, deadlineSource: "fallback" })]);
  expect(JSON.stringify(diagnostics)).not.toContain(secret); expect(JSON.stringify(diagnostics)).not.toContain("https:");
});
