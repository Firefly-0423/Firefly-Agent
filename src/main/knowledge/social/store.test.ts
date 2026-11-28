import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createSocialAtomStore } from "./store";
import type { SocialAtom } from "./types";
const atom = (id: string, patch: Partial<SocialAtom> = {}): SocialAtom => ({ id, conversationId: "c", type: "open_loop", content: id, evidenceTurnId: "t", evidenceQuote: "quote", createdAt: 1, status: "active", ...patch });
const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
it("starts empty and filters by conversation, status and exclusive expiry", () => {
  const store = createSocialAtomStore(); expect(store.listActive("c")).toEqual([]); expect(store.getById("missing")).toBeUndefined();
  store.replaceForTest([atom("live"), atom("boundary", { expiresAt: 10 }), atom("future", { expiresAt: 11 }), atom("other", { conversationId: "d" }), atom("resolved", { status: "resolved" }), atom("superseded", { status: "superseded" })]);
  vi.useFakeTimers(); vi.setSystemTime(10); expect(store.listActive("c").map(x => x.id)).toEqual(["live", "future"]);
});
it("deduplicates retries by evidence, type and trimmed content as well as ID", () => {
  const store = createSocialAtomStore();
  store.applyOperations("c", [atom("a"), atom("b", { content: " a " }), atom("a", { content: "changed" }), atom("foreign", { conversationId: "d" })].map(atom => ({ operation: "add", atom })));
  expect(store.listActive("c").map(x => x.id)).toEqual(["a"]);
});
it("applies writes and resolutions sequentially", () => {
  const store = createSocialAtomStore(); store.applyOperations("c", [{ operation: "add", atom: atom("a") }, { operation: "supersede", targetAtomId: "a", atom: atom("b") }, { operation: "resolve", targetAtomId: "b", evidenceTurnId: "answer", evidenceQuote: "done" }], 10);
  expect(store.getById("a")).toMatchObject({ status: "superseded", supersededByAtomId: "b" });
  expect(store.getById("b")).toMatchObject({ status: "resolved", resolvedByTurnId: "answer" }); expect(store.listActive("c", 10)).toEqual([]);
});
it.each(["missing", "foreign", "expired", "resolved"])("ignores supersede targeting %s", target => {
  const store = createSocialAtomStore(); store.replaceForTest([atom("foreign", { conversationId: "d" }), atom("expired", { expiresAt: 10 }), atom("resolved", { status: "resolved" })]);
  store.applyOperations("c", [{ operation: "supersede", targetAtomId: target, atom: atom("new") }], 10); expect(store.getById("new")).toBeUndefined();
});
it.each(["long_term", "short_term"] as const)("does not resolve a %s fact", type => {
  const store = createSocialAtomStore(); store.replaceForTest([atom("a", { type })]); store.applyOperations("c", [{ operation: "resolve", targetAtomId: "a", evidenceTurnId: "answer", evidenceQuote: "done" }]); expect(store.getById("a")?.status).toBe("active");
});
it("persists and hydrates data once without leaving staging files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-social-unit-")); dirs.push(root); const file = path.join(root, "nested", "atoms.json");
  createSocialAtomStore(file).applyOperations("c", [{ operation: "add", atom: atom("a") }]);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ schemaVersion: 1, atoms: [atom("a")] }); expect(fs.existsSync(file + ".tmp")).toBe(false);
  const fresh = createSocialAtomStore(file); expect(fresh.getById("a")).toEqual(atom("a")); fs.writeFileSync(file, "broken"); expect(fresh.getById("a")).toEqual(atom("a"));
});
it.each(["bad json", "{}", '{"atoms":{}}'])("treats invalid disk data %s as empty", raw => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-social-unit-")); dirs.push(root); const file = path.join(root, "atoms.json"); fs.writeFileSync(file, raw); expect(createSocialAtomStore(file).listActive("c")).toEqual([]);
});
