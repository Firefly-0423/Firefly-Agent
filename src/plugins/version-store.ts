import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { cp, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { inspectPluginDir, PLUGIN_ID_RE } from "./loader";

export interface PackageSource {
  kind: "bundled" | "curated-market" | "local-zip" | "legacy-unknown";
  sourceId: string;
  archiveSha256?: string;
}
/** Host-only approval for one validated local/bundled package to move to its confirmed online source. */
export interface ConfirmedSourceReplacement {
  selectedKey: string;
  from: PackageSource;
  to: PackageSource;
}
export interface StoredPackage {
  key: string;
  version: string;
  treeSha256: string;
  source: PackageSource;
}
export interface PluginVersionState {
  schemaVersion: 2;
  pluginId: string;
  revision: number;
  phase: "ready" | "activating" | "recovery-required" | "uninstalled";
  selected: StoredPackage | null;
  pending: StoredPackage | null;
  previous: StoredPackage | null;
  legacy?: { directory: string; treeSha256: string };
  error?: string;
}

const KEY = /^[a-f0-9-]{36}$/;
const DIGEST = /^[a-f0-9]{64}$/;

function sameSource(a: PackageSource, b: PackageSource): boolean {
  return a.kind === b.kind && a.sourceId === b.sourceId && a.archiveSha256 === b.archiveSha256;
}

function validLegacy(value: PluginVersionState["legacy"]): boolean {
  return value === undefined || (!!value && typeof value.directory === "string"
    && value.directory !== "." && value.directory !== ".."
    && /^[^\\/\x00-\x1f:]+$/.test(value.directory)
    && typeof value.treeSha256 === "string" && DIGEST.test(value.treeSha256));
}

/** Reject links in every existing ancestor, including host-owned storage roots. */
function assertNoLinkedAncestors(target: string): void {
  let current = path.resolve(target);
  for (;;) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("Linked plugin storage path");
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function treeDigest(directory: string): string {
  assertNoLinkedAncestors(directory);
  const hash = createHash("sha256");
  let count = 0, bytes = 0;
  const visit = (relative: string): void => {
    const target = path.join(directory, relative);
    const info = lstatSync(target);
    if (info.isSymbolicLink()) throw new Error("Linked plugin package entry");
    if (info.isDirectory()) {
      for (const name of readdirSync(target).sort()) visit(path.join(relative, name));
    } else if (info.isFile()) {
      if (++count > 2000 || (bytes += info.size) > 200 * 1024 * 1024) throw new Error("Plugin package exceeds limits");
      hash.update(JSON.stringify([relative.split(path.sep).join("/"), info.size]));
      hash.update(readFileSync(target));
    } else throw new Error("Unsupported plugin package entry");
  };
  visit("");
  return hash.digest("hex");
}

function validPackage(value: unknown): value is StoredPackage {
  if (!value || typeof value !== "object") return false;
  const p = value as StoredPackage;
  return typeof p.key === "string" && KEY.test(p.key) && typeof p.version === "string" && p.version.length > 0
    && typeof p.treeSha256 === "string" && DIGEST.test(p.treeSha256)
    && !!p.source && ["bundled", "curated-market", "local-zip", "legacy-unknown"].includes(p.source.kind)
    && typeof p.source.sourceId === "string" && p.source.sourceId.length > 0
    && (p.source.archiveSha256 === undefined || DIGEST.test(p.source.archiveSha256));
}

/** Host bookkeeping, not a sandbox against trusted main-process plugin code. */
export class PluginVersionStore {
  constructor(readonly userRoot: string) {}

  private checkId(id: string): void {
    if (!PLUGIN_ID_RE.test(id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id)) throw new Error("Invalid plugin ID");
  }

  recordPath(id: string): string {
    this.checkId(id);
    // Keep v1 provenance intact for migration and diagnostics; v2 is authoritative.
    const result = path.join(path.dirname(this.userRoot), "plugin-install-state", `${id}.json`);
    assertNoLinkedAncestors(result);
    return result;
  }

  packageDir(id: string, key: string): string {
    this.checkId(id);
    if (!KEY.test(key)) throw new Error("Invalid plugin package key");
    const storageKey = createHash("sha256").update(id).digest("hex");
    const result = path.join(path.dirname(this.userRoot), "plugin-packages", storageKey, key);
    assertNoLinkedAncestors(result);
    return result;
  }

  ids(): string[] {
    const root = path.dirname(this.recordPath("probe"));
    if (!existsSync(root)) return [];
    return [...new Set(readdirSync(root).filter(name => /\.json(?:\.pending)?$/.test(name))
      .map(name => name.replace(/\.json(?:\.pending)?$/, "")))];
  }

  read(id: string): PluginVersionState | undefined {
    const file = this.recordPath(id);
    if (!existsSync(file)) return undefined;
    if (lstatSync(file).size > 1024 * 1024) throw new Error("Plugin state exceeds limits");
    const state = JSON.parse(readFileSync(file, "utf8")) as PluginVersionState;
    if (!state || state.schemaVersion !== 2 || state.pluginId !== id || !Number.isSafeInteger(state.revision) || state.revision < 1
      || !["ready", "activating", "recovery-required", "uninstalled"].includes(state.phase)
      || ![state.selected, state.pending, state.previous].every(p => p === null || validPackage(p))
      || !validLegacy(state.legacy)
      || (state.phase === "activating" && !state.pending)) throw new Error("Invalid plugin version state");
    return state;
  }

  private async write(state: PluginVersionState): Promise<PluginVersionState> {
    const file = this.recordPath(state.pluginId);
    await mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temp, "wx");
    try { await handle.writeFile(JSON.stringify(state) + "\n", "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    try { assertNoLinkedAncestors(file); await rename(temp, file); }
    finally { await rm(temp, { force: true }); }
    return state;
  }

  async validate(id: string, stored: StoredPackage): Promise<void> {
    const dir = this.packageDir(id, stored.key);
    const manifest = inspectPluginDir(dir).manifest;
    if (!manifest || manifest.id !== id || manifest.version !== stored.version) throw new Error("Plugin package identity mismatch");
    if (treeDigest(dir) !== stored.treeSha256) throw new Error("Plugin package digest mismatch");
  }

  private async copyPackage(id: string, from: string, source: PackageSource): Promise<StoredPackage> {
    const digest = treeDigest(from);
    const manifest = inspectPluginDir(from).manifest;
    if (!manifest || manifest.id !== id) throw new Error("Plugin package identity mismatch");
    const key = randomUUID(), dir = this.packageDir(id, key);
    // Durable discovery precedes any package writes, including the first install.
    // A crash or failed copy/record commit remains visible to next-start GC.
    const marker = `${this.recordPath(id)}.pending`;
    assertNoLinkedAncestors(marker);
    await mkdir(path.dirname(marker), { recursive: true });
    const handle = await open(marker, "a");
    try { await handle.sync(); } finally { await handle.close(); }
    await mkdir(path.dirname(dir), { recursive: true });
    await cp(from, dir, { recursive: true, errorOnExist: true, force: false, dereference: false });
    const stored = { key, version: manifest.version, treeSha256: digest, source };
    if (!validPackage(stored)) throw new Error("Invalid plugin package provenance");
    await this.validate(id, stored);
    return stored;
  }

  async migrate(id: string, legacy: string): Promise<PluginVersionState> {
    const existing = this.read(id);
    if (existing) return existing;
    const directory = path.relative(path.resolve(this.userRoot), path.resolve(legacy));
    if (!validLegacy({ directory, treeSha256: "0".repeat(64) })) throw new Error("Invalid legacy directory");
    const selected = await this.copyPackage(id, legacy, { kind: "legacy-unknown", sourceId: "legacy-unknown" });
    return this.write({ schemaVersion: 2, pluginId: id, revision: 1, phase: "ready", selected, pending: null, previous: null,
      legacy: { directory, treeSha256: selected.treeSha256 } });
  }

  async stage(id: string, from: string, source: PackageSource, options: { confirmedSourceReplacement?: ConfirmedSourceReplacement } = {}): Promise<PluginVersionState> {
    const before = this.read(id);
    if (before?.pending || before?.phase === "activating" || before?.phase === "recovery-required") throw new Error("Plugin operation requires recovery or restart");
    const priorSource = before?.selected?.source;
    if (priorSource && priorSource.kind !== "legacy-unknown"
      && (priorSource.kind !== source.kind || priorSource.sourceId !== source.sourceId)) {
      const approval = options.confirmedSourceReplacement;
      if (!approval || (priorSource.kind !== "local-zip" && priorSource.kind !== "bundled")
        || source.kind !== "curated-market" || !source.archiveSha256 || !DIGEST.test(source.archiveSha256)
        || approval.selectedKey !== before?.selected?.key
        || !sameSource(priorSource, approval.from) || !sameSource(source, approval.to)) {
        throw new Error("Plugin source replacement refused");
      }
    }
    const pending = await this.copyPackage(id, from, source);
    return this.write({ schemaVersion: 2, pluginId: id, revision: (before?.revision ?? 0) + 1,
      phase: "ready", selected: before?.selected ?? null, pending, previous: before?.previous ?? null, legacy: before?.legacy });
  }

  async beginActivation(id: string): Promise<PluginVersionState> {
    const before = this.read(id);
    if (!before?.pending || before.phase !== "ready") throw new Error("No pending plugin package");
    await this.validate(id, before.pending);
    return this.write({ ...before, revision: before.revision + 1, phase: "activating" });
  }

  async finishActivation(id: string): Promise<PluginVersionState> {
    const before = this.read(id);
    if (!before?.pending || before.phase !== "activating") throw new Error("Plugin activation was not started");
    return this.write({ ...before, revision: before.revision + 1, phase: "ready", selected: before.pending,
      previous: before.selected, pending: null, error: undefined });
  }

  async failActivation(id: string, error: string, restoreSelection?: StoredPackage | null): Promise<PluginVersionState> {
    const before = this.read(id);
    if (!before) throw new Error("Missing plugin version state");
    // Preserve both directories; restoration is selection-only and never hot-loads old code.
    return this.write({ ...before, revision: before.revision + 1, phase: "ready", pending: null,
      selected: restoreSelection === undefined ? before.selected : restoreSelection, error });
  }

  async recoverInterrupted(id: string): Promise<void> {
    if (this.read(id)?.phase === "activating") await this.failActivation(id, "Interrupted plugin activation; previous selection restored");
  }

  /** Call only before this process has loaded any package for the ID. */
  async collect(id: string): Promise<void> {
    const state = this.read(id);
    const keep = new Set(!state || state.phase === "uninstalled" ? [] : [state.selected, state.pending, state.previous].flatMap(p => p ? [p.key] : []));
    const root = path.dirname(this.packageDir(id, "00000000-0000-0000-0000-000000000000"));
    if (existsSync(root)) {
      for (const key of readdirSync(root)) {
        if (!KEY.test(key) || keep.has(key)) continue;
        const dir = this.packageDir(id, key);
        treeDigest(dir); // Reject nested links before a recursive deletion.
        await rm(dir, { recursive: true, force: false });
      }
    }
    if (state?.phase === "uninstalled" && state.legacy) {
      const legacy = path.join(this.userRoot, state.legacy.directory);
      if (existsSync(legacy)) {
        if (treeDigest(legacy) !== state.legacy.treeSha256 || inspectPluginDir(legacy).manifest?.id !== id) {
          throw new Error("Legacy directory changed; manual cleanup required");
        }
        await rm(legacy, { recursive: true, force: false });
      }
    }
    const marker = `${this.recordPath(id)}.pending`;
    assertNoLinkedAncestors(marker);
    await rm(marker, { force: true });
  }

  async uninstall(id: string): Promise<void> {
    const before = this.read(id);
    if (before) await this.write({ ...before, revision: before.revision + 1, phase: "uninstalled", previous: before.selected, selected: null, pending: null });
  }
}
