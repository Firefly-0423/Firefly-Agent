import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageContext, type StorageContext } from "../storage-context";
import { resolveRuntimeProfile } from "../runtime-profile";
import * as runtimePaths from "../runtime-profile";
import type { ChatSessionMeta } from "../../shared/chat-types";
import { createSidebarLayoutStore as createStore, type SidebarLayoutStore } from "./sidebar-layout-store";
import type { SidebarPatch } from "../../shared/sidebar-layout";

let root: string;
let storage: StorageContext;
let sessions: ChatSessionMeta[];
let store: SidebarLayoutStore;
const session = (id: string, workspaceRoot?: string): ChatSessionMeta => ({
  id, title: id, identityId: null, mode: "work", createdAt: 1, updatedAt: 1, messageCount: 0,
  ...(workspaceRoot ? { workspaceRoot, workspaceDisplayName: "Same name" } : {}),
});
const patch = (value: SidebarPatch) => store.applyPatch({ expectedRevision: store.getSnapshot().layout.revision, patch: value });
const createSection = () => {
  expect(patch({ mode: "work", kind: "create-section", name: "Research" }).ok).toBe(true);
  return store.getSnapshot().layout.modes.work.sections[0].id;
};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-sidebar-test-"));
  const isolationRoot = path.join(root, "isolated");
  fs.mkdirSync(isolationRoot);
  storage = createStorageContext(resolveRuntimeProfile({ argv: ["--firefly-profile=test", `--firefly-isolation-root=${isolationRoot}`], env: {}, isPackaged: false, productionAppData: path.join(root, "production") }));
  sessions = [session("a", path.join(root, "project-a")), session("b", path.join(root, "project-b")), session("unbound")];
  store = createStore(storage, () => sessions);
});
afterEach(() => {
  vi.restoreAllMocks();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("sidebar layout storage", () => {
  it("uses only stateRoot, preserves sessions, and reopens stable project/section identities", () => {
    const original = JSON.stringify(sessions);
    const initial = store.getSnapshot();
    expect(initial.layout.projects).toHaveLength(2);
    expect(new Set(initial.layout.projects.map(project => project.id)).size).toBe(2);
    const sectionId = createSection();
    const reopened = createStore(storage, () => sessions).getSnapshot();
    expect(reopened.layout.modes.work.sections[0].id).toBe(sectionId);
    expect(reopened.sessionProjectIds).toEqual(initial.sessionProjectIds);
    expect(fs.existsSync(path.join(storage.stateRoot, "sidebar-layout.json"))).toBe(true);
    expect(fs.existsSync(path.join(storage.sessionRoot, "sidebar-layout.json"))).toBe(false);
    expect(JSON.stringify(sessions)).toBe(original);
  });
  it("associates normalized root aliases without rebinding sessions", () => {
    sessions.push(session("alias", `${path.join(root, "project-a")}${path.sep}nested${path.sep}..`));
    const snapshot = store.getSnapshot();
    expect(snapshot.sessionProjectIds.alias).toBe(snapshot.sessionProjectIds.a);
    expect(snapshot.layout.projects).toHaveLength(2);
    expect(sessions[3].workspaceRoot).toContain("..");
  });
  it("persists mode-local view, visibility, collapse, project placement and group order", () => {
    const projectId = store.getSnapshot().sessionProjectIds.a!;
    const sectionId = createSection();
    const groupId = `work:section:${sectionId}`;
    for (const value of [
      { mode: "work", kind: "set-view", viewMode: "merged" },
      { mode: "work", kind: "set-sort", sortMode: "manual" },
      { mode: "work", kind: "set-project-visible", projectId, visible: false },
      { mode: "work", kind: "set-expanded", groupId, expanded: false },
      { mode: "work", kind: "move-project", projectId, sectionId },
      { mode: "work", kind: "set-group-order", groupIds: [groupId, "work:default"] },
    ] as SidebarPatch[]) expect(patch(value).ok).toBe(true);
    const value = createStore(storage, () => sessions).getSnapshot().layout.modes;
    expect(value.work).toMatchObject({ viewMode: "merged", sortMode: "manual", hiddenProjectIds: [projectId], collapsedGroupIds: [groupId], projectSections: { [projectId]: sectionId }, groupOrder: [groupId, "work:default"] });
    expect(value.code.sections).toEqual([]);
    expect(value.chat.viewMode).toBe("merged");
  });
  it("Chat files conversations in sections; deleting the section releases them", () => {
    sessions.push({ ...session("c1"), mode: "chat" }, { ...session("c2"), mode: "chat" });
    expect(patch({ mode: "chat", kind: "create-section", name: "Ideas" }).ok).toBe(true);
    const sectionId = store.getSnapshot().layout.modes.chat.sections[0].id;
    expect(patch({ mode: "chat", kind: "move-session", sessionId: "c1", sectionId }).ok).toBe(true);
    expect(store.getSnapshot().layout.modes.chat.membership).toEqual({ c1: sectionId });
    // Work conversations never leave their project.
    expect(patch({ mode: "work", kind: "move-session", sessionId: "a", sectionId }).ok).toBe(false);
    expect(patch({ mode: "chat", kind: "delete-section", sectionId }).ok).toBe(true);
    expect(store.getSnapshot().layout.modes.chat.membership).toEqual({});
  });
  it("rejects stale revisions across store instances with the newest snapshot", () => {
    const other = createStore(storage, () => sessions);
    const revision = other.getSnapshot().layout.revision;
    createSection();
    const result = other.applyPatch({ expectedRevision: revision, patch: { mode: "work", kind: "set-sort", sortMode: "manual" } });
    expect(result).toMatchObject({ ok: false, code: "conflict", snapshot: { layout: { revision: revision + 1 } } });
    expect(other.getSnapshot().layout.modes.work.sortMode).toBe("recent");
  });
  it.each(["{broken", JSON.stringify({ schemaVersion: 42 })])("refuses writes to unreadable or unsupported metadata: %s", bytes => {
    fs.mkdirSync(storage.stateRoot, { recursive: true });
    const file = path.join(storage.stateRoot, "sidebar-layout.json");
    fs.writeFileSync(file, bytes);
    const result = store.applyPatch({ expectedRevision: 0, patch: { mode: "work", kind: "set-sort", sortMode: "manual" } });
    expect(result).toMatchObject({ ok: false, code: "storage_error" });
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    expect(fs.readdirSync(storage.stateRoot)).toEqual(["sidebar-layout.json"]);
  });
  it.each(["duplicate-order", "invalid-membership", "foreign-project-root"])("rejects malformed stored identities without overwriting: %s", corruption => {
    createSection();
    const value = store.getSnapshot().layout;
    if (corruption === "duplicate-order") value.modes.work.groupOrder = ["work:default", "work:default"];
    if (corruption === "invalid-membership") value.modes.work.membership.a = "unknown-section";
    if (corruption === "foreign-project-root") value.projects[0].workspaceRoot = path.join(root, "other-project");
    const file = path.join(storage.stateRoot, "sidebar-layout.json");
    const bytes = JSON.stringify(value);
    fs.writeFileSync(file, bytes);
    expect(store.applyPatch({ expectedRevision: value.revision, patch: { mode: "work", kind: "set-sort", sortMode: "manual" } })).toMatchObject({ ok: false, code: "storage_error" });
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
  });
  it("failed atomic replacement preserves original bytes and revision", () => {
    createSection();
    const file = path.join(storage.stateRoot, "sidebar-layout.json");
    const bytes = fs.readFileSync(file, "utf8");
    const revision = store.getSnapshot().layout.revision;
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw Object.assign(new Error("ordinary EPERM"), { code: "EPERM" }); });
    expect(store.applyPatch({ expectedRevision: revision, patch: { mode: "work", kind: "set-sort", sortMode: "manual" } })).toMatchObject({ ok: false, code: "storage_error" });
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    expect(store.getSnapshot().layout.revision).toBe(revision);
    expect(fs.readdirSync(storage.stateRoot)).toEqual(["sidebar-layout.json"]);
  });
  it.each(["test", "development"] as const)("requires explicit ownership for %s instead of production fallback", kind => {
    const profile = { ...storage.profile, kind, isolationRoot: undefined };
    expect(() => createStore({ ...storage, profile }, () => sessions)).toThrow();
    expect(() => createStore({ ...storage, stateRoot: path.join(root, "production") }, () => sessions)).toThrow();
    expect(fs.existsSync(path.join(root, "production"))).toBe(false);
  });
  it("rejects unknown or cross-mode identities and duplicate orders without creating a file", () => {
    sessions.push({ ...session("chat-only"), mode: "chat" });
    for (const value of [
      { mode: "work", kind: "move-session", sessionId: "chat-only", sectionId: null },
      { mode: "work", kind: "set-project-visible", projectId: "foreign", visible: false },
      { mode: "work", kind: "set-group-order", groupIds: ["work:default", "work:default"] },
      { mode: "work", kind: "set-expanded", groupId: "code:default", expanded: false },
      { mode: "chat", kind: "set-view", viewMode: "project" },
      { mode: "work", kind: "create-section", name: "   " },
    ] as SidebarPatch[]) expect(patch(value)).toMatchObject({ ok: false, code: "invalid" });
    expect(fs.existsSync(path.join(storage.stateRoot, "sidebar-layout.json"))).toBe(false);
  });
  it("returns detached snapshots and never persists caller mutations", () => {
    const snapshot = store.getSnapshot();
    snapshot.layout.modes.work.sections.push({ id: "foreign", name: "Changed" });
    snapshot.layout.projects[0].displayName = "Changed";
    expect(store.getSnapshot().layout.modes.work.sections).toEqual([]);
    expect(store.getSnapshot().layout.projects[0].displayName).toBe("Same name");
  });
  it("keeps saved manual order when toggling recent/manual after activity changes", () => {
    patch({ mode: "work", kind: "set-view", viewMode: "merged" });
    patch({ mode: "work", kind: "set-sort", sortMode: "manual" });
    patch({ mode: "work", kind: "move-session", sessionId: "b", sectionId: null, beforeSessionId: "a" });
    const expected = store.getSnapshot().layout.modes.work.manualOrders["work:default"];
    patch({ mode: "work", kind: "set-sort", sortMode: "recent" });
    sessions[0].updatedAt = 9999;
    patch({ mode: "work", kind: "set-sort", sortMode: "manual" });
    expect(store.getSnapshot().layout.modes.work.manualOrders["work:default"]).toEqual(expected);
  });
  it("removes a partially written temporary file without changing durable bytes", () => {
    createSection();
    const file = path.join(storage.stateRoot, "sidebar-layout.json");
    const bytes = fs.readFileSync(file, "utf8");
    const revision = store.getSnapshot().layout.revision;
    const original = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, "writeFileSync").mockImplementationOnce((target, _data, options) => {
      original(target, "partial", options);
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });
    expect(patch({ mode: "work", kind: "set-sort", sortMode: "manual" })).toMatchObject({ ok: false, code: "storage_error" });
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    expect(store.getSnapshot().layout.revision).toBe(revision);
    expect(fs.readdirSync(storage.stateRoot)).toEqual(["sidebar-layout.json"]);
  });
  it("appends new manual IDs deterministically across recent-list refreshes and reopening", () => {
    patch({ mode: "work", kind: "set-view", viewMode: "merged" });
    patch({ mode: "work", kind: "set-sort", sortMode: "manual" });
    const previous = store.getSnapshot().layout.modes.work.manualOrders["work:default"];
    sessions.push({ ...session("newer"), createdAt: 3 }, { ...session("older"), createdAt: 2 });
    const first = store.getSnapshot().layout.modes.work.manualOrders["work:default"];
    expect(first).toEqual([...previous, "older", "newer"]);
    sessions.reverse();
    for (const item of sessions) item.updatedAt = 9999;
    expect(store.getSnapshot().layout.modes.work.manualOrders["work:default"]).toEqual(first);
    expect(createStore(storage, () => sessions).getSnapshot().layout.modes.work.manualOrders["work:default"]).toEqual(first);
  });
  it("keeps project manual order across merged/project view transitions", () => {
    sessions.push(session("same-project", sessions[0].workspaceRoot));
    patch({ mode: "work", kind: "set-sort", sortMode: "manual" });
    const sectionId = createSection();
    patch({ mode: "work", kind: "move-session", sessionId: "same-project", sectionId });
    patch({ mode: "work", kind: "move-session", sessionId: "same-project", sectionId: null, beforeSessionId: "a" });
    const groupId = `work:project:${store.getSnapshot().sessionProjectIds.a}`;
    expect(store.getSnapshot().layout.modes.work.manualOrders[groupId]).toEqual(["same-project", "a"]);
    expect(patch({ mode: "work", kind: "set-view", viewMode: "merged" }).ok).toBe(true);
    expect(patch({ mode: "work", kind: "set-view", viewMode: "project" }).ok).toBe(true);
    expect(createStore(storage, () => sessions).getSnapshot().layout.modes.work.manualOrders[groupId]).toEqual(["same-project", "a"]);
  });
  it("rejects an exact metadata path resolving outside stateRoot in production too", () => {
    createSection();
    const actualCanonical = runtimePaths.canonicalPath;
    const file = path.join(storage.stateRoot, "sidebar-layout.json");
    const bytes = fs.readFileSync(file, "utf8");
    vi.spyOn(runtimePaths, "canonicalPath").mockImplementation(target => target === file ? path.join(root, "external-layout.json") : actualCanonical(target));
    expect(() => createStore({ ...storage, profile: { ...storage.profile, kind: "production", isolationRoot: undefined } }, () => sessions)).toThrow("FIREFLY_RUNTIME_PATH_ESCAPE");
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
  });
});
