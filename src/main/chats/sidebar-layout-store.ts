import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ChatSessionMeta, ConversationMode } from "../../shared/chat-types";
import { SIDEBAR_MODES, compareSidebarCreation, orderSidebarSessions, sidebarGroupId, sidebarSessionGroup, type ModeSidebarLayout, type SidebarLayout, type SidebarMutation, type SidebarMutationResult, type SidebarPatch, type SidebarSnapshot } from "../../shared/sidebar-layout";
import { assertRuntimePathsOwned, canonicalPath, within } from "../startup/runtime-profile";
import type { StorageContext } from "../storage/storage-context";

export interface SidebarLayoutStore {
  getSnapshot(): SidebarSnapshot;
  applyPatch(mutation: SidebarMutation): SidebarMutationResult;
}
const copy = <T>(value: T): T => structuredClone(value);
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const safeId = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(value) && !["constructor", "prototype", "__proto__"].includes(value);
const name = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 120 && !/[\u0000-\u001f]/.test(value);
function requireValue(condition: unknown): asserts condition { if (!condition) throw new Error("FIREFLY_SIDEBAR_INVALID"); }
function uniqueIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(safeId) && new Set(value).size === value.length;
}
function normalizeRoot(root: string): string {
  const resolved = canonicalPath(path.resolve(root.trim()));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
const projectIdFor = (root: string) => `project-${createHash("sha256").update(root).digest("hex").slice(0, 24)}`;
function defaultMode(mode: ConversationMode): ModeSidebarLayout {
  return { viewMode: mode === "chat" ? "merged" : "project", sortMode: "recent", hiddenProjectIds: [], sections: [], collapsedGroupIds: [], membership: {}, manualOrders: {}, groupOrder: [], ...(mode === "chat" ? {} : { pinnedProjectIds: [], projectSections: {} }) };
}
function emptyLayout(): SidebarLayout {
  return { schemaVersion: 1, revision: 0, projects: [], modes: { chat: defaultMode("chat"), work: defaultMode("work"), code: defaultMode("code") } };
}
function knownGroups(layout: SidebarLayout, mode: ConversationMode): Set<string> {
  return new Set([sidebarGroupId.default(mode), ...layout.modes[mode].sections.map(section => sidebarGroupId.section(mode, section.id)), ...(mode === "chat" ? [] : layout.projects.map(project => sidebarGroupId.project(mode, project.id)))]);
}
/** Validate stored data before reconciling it; corrupt metadata is never repaired by overwriting. */
function validateLayout(value: unknown): asserts value is SidebarLayout {
  requireValue(object(value) && value.schemaVersion === 1 && Number.isSafeInteger(value.revision) && (value.revision as number) >= 0);
  requireValue(Array.isArray(value.projects) && object(value.modes));
  const projects = new Set<string>();
  const roots = new Set<string>();
  for (const project of value.projects) {
    requireValue(object(project) && safeId(project.id) && typeof project.workspaceRoot === "string" && path.isAbsolute(project.workspaceRoot) && name(project.displayName));
    const root = normalizeRoot(project.workspaceRoot);
    requireValue(project.workspaceRoot === root && project.id === projectIdFor(root) && !projects.has(project.id) && !roots.has(root));
    projects.add(project.id); roots.add(root);
  }
  for (const mode of SIDEBAR_MODES) {
    const state = value.modes[mode];
    requireValue(object(state) && ["project", "merged"].includes(state.viewMode as string) && ["recent", "manual"].includes(state.sortMode as string));
    requireValue(mode !== "chat" || state.viewMode === "merged");
    requireValue(uniqueIds(state.hiddenProjectIds) && state.hiddenProjectIds.every(id => projects.has(id)));
    requireValue(Array.isArray(state.sections) && object(state.membership) && object(state.manualOrders));
    const sections = new Set<string>();
    for (const section of state.sections) {
      requireValue(object(section) && safeId(section.id) && name(section.name) && !sections.has(section.id));
      sections.add(section.id);
    }
    const groups = knownGroups(value as unknown as SidebarLayout, mode);
    if (state.pinnedProjectIds !== undefined) requireValue(mode !== "chat" && uniqueIds(state.pinnedProjectIds) && state.pinnedProjectIds.every(id => projects.has(id)));
    if (state.projectSections !== undefined) {
      requireValue(mode !== "chat" && object(state.projectSections));
      for (const [id, sectionId] of Object.entries(state.projectSections)) requireValue(projects.has(id) && typeof sectionId === "string" && sections.has(sectionId));
    }
    for (const [id, sectionId] of Object.entries(state.membership)) requireValue(safeId(id) && typeof sectionId === "string" && sections.has(sectionId));
    requireValue(uniqueIds(state.collapsedGroupIds) && state.collapsedGroupIds.every(id => groups.has(id)));
    requireValue(uniqueIds(state.groupOrder) && state.groupOrder.every(id => groups.has(id)));
    for (const [groupId, order] of Object.entries(state.manualOrders)) {
      requireValue(groups.has(groupId) && uniqueIds(order));
    }
  }
}
function sessionList(readSessions: () => readonly ChatSessionMeta[]): ChatSessionMeta[] {
  const unique = new Map<string, ChatSessionMeta>();
  for (const session of readSessions()) {
    requireValue(safeId(session.id) && SIDEBAR_MODES.includes(session.mode) && Number.isFinite(session.updatedAt) && Number.isFinite(session.createdAt));
    if (!unique.has(session.id)) unique.set(session.id, session);
  }
  return [...unique.values()];
}
function groupedSessions(snapshot: SidebarSnapshot, mode: ConversationMode, sessions: readonly ChatSessionMeta[]): Map<string, ChatSessionMeta[]> {
  const groups = new Map<string, ChatSessionMeta[]>();
  for (const session of sessions) {
    if (session.mode !== mode) continue;
    const groupId = sidebarSessionGroup(snapshot, mode, session.id);
    const members = groups.get(groupId) ?? [];
    members.push(session); groups.set(groupId, members);
  }
  return groups;
}
function reconcile(layout: SidebarLayout, sessions: readonly ChatSessionMeta[]): SidebarSnapshot {
  const sessionProjectIds: Record<string, string | null> = {};
  const projects = new Map(layout.projects.map(project => [project.id, project]));
  for (const session of sessions) {
    sessionProjectIds[session.id] = null;
    if (session.mode === "chat" || !session.workspaceRoot?.trim()) continue;
    requireValue(path.isAbsolute(session.workspaceRoot));
    const root = normalizeRoot(session.workspaceRoot);
    const id = projectIdFor(root);
    sessionProjectIds[session.id] = id;
    if (!projects.has(id)) {
      const displayName = session.workspaceDisplayName?.trim() || path.basename(root) || root;
      projects.set(id, { id, workspaceRoot: root, displayName: displayName.slice(0, 120) });
    }
  }
  layout.projects = [...projects.values()];
  const snapshot = { layout, sessionProjectIds, notices: [] };
  for (const mode of SIDEBAR_MODES) {
    const state = layout.modes[mode];
    const validSessions = new Set(sessions.filter(session => session.mode === mode).map(session => session.id));
    for (const id of Object.keys(state.membership)) if (!validSessions.has(id)) delete state.membership[id];
    if (mode !== "chat") {
      state.pinnedProjectIds ??= [];
      state.projectSections ??= {};
      // Older layouts put work and code conversations straight into sections, which pulled them out of their project.
      // The section now belongs to the project; the conversations stay where they are bound.
      for (const [id, sectionId] of Object.entries(state.membership)) {
        const projectId = sessionProjectIds[id];
        if (projectId && !state.projectSections[projectId]) state.projectSections[projectId] = sectionId;
        delete state.membership[id];
      }
      const sectionIds = new Set(state.sections.map(section => section.id));
      for (const [projectId, sectionId] of Object.entries(state.projectSections)) if (!projects.has(projectId) || !sectionIds.has(sectionId)) delete state.projectSections[projectId];
      state.pinnedProjectIds = state.pinnedProjectIds.filter(id => projects.has(id));
    }
    const groups = groupedSessions(snapshot, mode, sessions);
    for (const [groupId, order] of Object.entries(state.manualOrders)) {
      // Preserve alternate project/merged view orders. Only deleted or moved members leave them.
      const members = new Set(sessions.filter(session => {
        if (session.mode !== mode) return false;
        const sectionId = state.membership[session.id];
        if (sectionId) return groupId === sidebarGroupId.section(mode, sectionId);
        const projectId = sessionProjectIds[session.id];
        return groupId === sidebarGroupId.default(mode) || (mode !== "chat" && projectId !== null && groupId === sidebarGroupId.project(mode, projectId));
      }).map(session => session.id));
      state.manualOrders[groupId] = order.filter(id => members.has(id));
    }
    if (state.sortMode === "manual") {
      for (const [groupId, members] of groups) {
        const existing = state.manualOrders[groupId] ?? [];
        const known = new Set(existing);
        state.manualOrders[groupId] = [...existing, ...members.filter(session => !known.has(session.id)).sort(compareSidebarCreation).map(session => session.id)];
      }
    }
  }
  return snapshot;
}
function apply(snapshot: SidebarSnapshot, patch: SidebarPatch, sessions: readonly ChatSessionMeta[]): void {
  requireValue(object(patch) && SIDEBAR_MODES.includes(patch.mode));
  const state = snapshot.layout.modes[patch.mode];
  const groups = knownGroups(snapshot.layout, patch.mode);
  const section = (id: string) => state.sections.find(item => item.id === id);
  const project = (id: string) => snapshot.layout.projects.find(item => item.id === id);
  switch (patch.kind) {
    case "set-view":
      requireValue(["project", "merged"].includes(patch.viewMode) && (patch.mode !== "chat" || patch.viewMode === "merged"));
      state.viewMode = patch.viewMode; break;
    case "set-sort":
      requireValue(["recent", "manual"].includes(patch.sortMode));
      if (state.sortMode !== "manual" && patch.sortMode === "manual") {
        for (const [groupId, members] of groupedSessions(snapshot, patch.mode, sessions)) {
          if (!state.manualOrders[groupId]) state.manualOrders[groupId] = orderSidebarSessions(members, state, groupId).map(session => session.id);
        }
      }
      state.sortMode = patch.sortMode; break;
    case "set-project-visible":
      requireValue(typeof patch.visible === "boolean" && sessions.some(session => session.mode === patch.mode && snapshot.sessionProjectIds[session.id] === patch.projectId));
      state.hiddenProjectIds = state.hiddenProjectIds.filter(id => id !== patch.projectId);
      if (!patch.visible) state.hiddenProjectIds.push(patch.projectId); break;
    case "set-expanded":
      requireValue(groups.has(patch.groupId) && typeof patch.expanded === "boolean");
      state.collapsedGroupIds = state.collapsedGroupIds.filter(id => id !== patch.groupId);
      if (!patch.expanded) state.collapsedGroupIds.push(patch.groupId); break;
    case "create-section":
      requireValue(name(patch.name));
      state.sections.push({ id: `section-${randomUUID()}`, name: patch.name.trim() }); break;
    case "rename-section":
      requireValue(section(patch.sectionId) && name(patch.name));
      section(patch.sectionId)!.name = patch.name.trim(); break;
    case "delete-section": {
      requireValue(section(patch.sectionId));
      state.sections = state.sections.filter(item => item.id !== patch.sectionId);
      for (const [id, sectionId] of Object.entries(state.membership)) if (sectionId === patch.sectionId) delete state.membership[id];
      for (const [id, sectionId] of Object.entries(state.projectSections ?? {})) if (sectionId === patch.sectionId) delete state.projectSections![id];
      const groupId = sidebarGroupId.section(patch.mode, patch.sectionId);
      delete state.manualOrders[groupId];
      state.collapsedGroupIds = state.collapsedGroupIds.filter(id => id !== groupId);
      state.groupOrder = state.groupOrder.filter(id => id !== groupId); break;
    }
    case "move-session": {
      requireValue(sessions.some(session => session.id === patch.sessionId && session.mode === patch.mode));
      // Only Chat files conversations in sections; work and code file whole projects, so a conversation there only reorders.
      requireValue(patch.sectionId === null || (patch.mode === "chat" && section(patch.sectionId)));
      const oldGroup = sidebarSessionGroup(snapshot, patch.mode, patch.sessionId);
      const priorGroups = groupedSessions(snapshot, patch.mode, sessions);
      if (patch.sectionId === null) delete state.membership[patch.sessionId];
      else state.membership[patch.sessionId] = patch.sectionId;
      const target = sidebarSessionGroup(snapshot, patch.mode, patch.sessionId);
      const targetMembers = groupedSessions(snapshot, patch.mode, sessions).get(target) ?? [];
      requireValue(patch.beforeSessionId === undefined || (patch.beforeSessionId !== patch.sessionId && targetMembers.some(session => session.id === patch.beforeSessionId)));
      for (const groupId of new Set([oldGroup, target])) {
        if (!state.manualOrders[groupId]) state.manualOrders[groupId] = orderSidebarSessions(priorGroups.get(groupId) ?? [], state, groupId).map(session => session.id);
      }
      for (const groupId of Object.keys(state.manualOrders)) state.manualOrders[groupId] = state.manualOrders[groupId].filter(id => id !== patch.sessionId);
      const order = state.manualOrders[target];
      const before = patch.beforeSessionId === undefined ? order.length : order.indexOf(patch.beforeSessionId);
      requireValue(before >= 0);
      order.splice(before, 0, patch.sessionId); break;
    }
    case "set-group-order":
      requireValue(uniqueIds(patch.groupIds) && patch.groupIds.every(id => groups.has(id)));
      state.groupOrder = [...patch.groupIds]; break;
    case "pin-project":
      requireValue(patch.mode !== "chat" && typeof patch.pinned === "boolean" && project(patch.projectId));
      state.pinnedProjectIds = (state.pinnedProjectIds ?? []).filter(id => id !== patch.projectId);
      if (patch.pinned) state.pinnedProjectIds.push(patch.projectId); break;
    case "move-project":
      requireValue(patch.mode !== "chat" && project(patch.projectId) && (patch.sectionId === null || section(patch.sectionId)));
      state.projectSections ??= {};
      if (patch.sectionId === null) delete state.projectSections[patch.projectId];
      else state.projectSections[patch.projectId] = patch.sectionId; break;
    case "rename-project":
      requireValue(project(patch.projectId) && name(patch.name));
      project(patch.projectId)!.displayName = patch.name.trim(); break;
    default: throw new Error("FIREFLY_SIDEBAR_INVALID");
  }
}

/** Main owns identities and the only durable file; no global StorageContext fallback. */
export function createSidebarLayoutStore(storage: StorageContext, readSessions: () => readonly ChatSessionMeta[]): SidebarLayoutStore {
  if (storage.profile.kind !== "production" && !storage.profile.isolationRoot) throw new Error("FIREFLY_RUNTIME_ISOLATION_REQUIRED");
  const file = path.join(storage.stateRoot, "sidebar-layout.json");
  const originalRoot = canonicalPath(storage.stateRoot);
  const assertOwned = (targets: readonly string[]) => {
    assertRuntimePathsOwned(storage.profile, [storage.stateRoot, file, ...targets]);
    if (canonicalPath(storage.stateRoot) !== originalRoot || !within(canonicalPath(storage.profile.userData), canonicalPath(storage.stateRoot))) throw new Error("FIREFLY_RUNTIME_PATH_ESCAPE");
    for (const target of [file, ...targets]) if (!within(originalRoot, canonicalPath(target))) throw new Error("FIREFLY_RUNTIME_PATH_ESCAPE");
  };
  assertOwned([]);
  let cached: { bytes: string | undefined; layout: SidebarLayout } | undefined;
  const read = (): { snapshot: SidebarSnapshot; sessions: ChatSessionMeta[] } => {
    assertOwned([]);
    let bytes: string | undefined;
    try { bytes = fs.readFileSync(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const layout: unknown = cached && cached.bytes === bytes ? copy(cached.layout) : bytes === undefined ? emptyLayout() : JSON.parse(bytes);
    validateLayout(layout);
    const sessions = sessionList(readSessions);
    const snapshot = reconcile(layout, sessions);
    cached = { bytes, layout: copy(snapshot.layout) };
    return { snapshot, sessions };
  };
  return {
    getSnapshot: () => copy(read().snapshot),
    applyPatch(mutation): SidebarMutationResult {
      let current: ReturnType<typeof read>;
      try { current = read(); }
      catch (error) { return { ok: false, code: "storage_error", error: error instanceof Error ? error.message : String(error) }; }
      if (!object(mutation) || !Number.isSafeInteger(mutation.expectedRevision) || mutation.expectedRevision < 0) return { ok: false, code: "invalid", snapshot: copy(current.snapshot) };
      if (mutation.expectedRevision !== current.snapshot.layout.revision) return { ok: false, code: "conflict", snapshot: copy(current.snapshot) };
      let next: SidebarSnapshot;
      try {
        next = copy(current.snapshot);
        apply(next, mutation.patch, current.sessions);
        next = reconcile(next.layout, current.sessions);
        next.layout.revision++;
        validateLayout(next.layout);
      } catch (error) { return { ok: false, code: "invalid", snapshot: copy(current.snapshot), error: error instanceof Error ? error.message : String(error) }; }
      const temporary = path.join(storage.stateRoot, `.sidebar-layout-${randomUUID()}.tmp`);
      let ownsTemporary = false;
      try {
        assertOwned([temporary]);
        fs.mkdirSync(storage.stateRoot, { recursive: true });
        const bytes = `${JSON.stringify(next.layout, null, 2)}\n`;
        const descriptor = fs.openSync(temporary, "wx");
        ownsTemporary = true;
        try {
          fs.writeFileSync(descriptor, bytes, "utf8");
          fs.fsyncSync(descriptor);
        } finally { fs.closeSync(descriptor); }
        assertOwned([temporary]);
        fs.renameSync(temporary, file);
        ownsTemporary = false;
        cached = { bytes, layout: copy(next.layout) };
        return { ok: true, snapshot: copy(next) };
      } catch (error) {
        return { ok: false, code: "storage_error", snapshot: copy(current.snapshot), error: error instanceof Error ? error.message : String(error) };
      } finally {
        if (ownsTemporary) {
          try { assertOwned([temporary]); fs.unlinkSync(temporary); } catch { /* Preserve the primary save failure; never remove an unowned target. */ }
        }
      }
    },
  };
}
