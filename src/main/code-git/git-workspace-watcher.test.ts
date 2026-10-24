import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createCodeGitIgnoredPredicate, createGitWorkspaceWatcher, type NativeEventEvidence, type WorkspaceFsWatcher } from "./git-workspace-watcher";
afterEach(() => vi.useRealTimers());
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
function adapter() {
    const callbacks = new Map<string, (value?: unknown) => void>();
    const transport: WorkspaceFsWatcher = { on: (name, callback) => { callbacks.set(name, callback); return transport; }, close: vi.fn(async () => undefined) };
    return { transport, emit: (name: string) => callbacks.get(name)?.("changed-file.ts") };
}
const workspace = resolve("watcher-contract-workspace");
const subscription = (sessionId: string) => ({ sessionId, workspaceRoot: workspace, gitDir: join(workspace, ".git") });
describe("workspace subscription lifetime", () => {
    it("shares a watcher and delivers an ordered session list at the 300ms debounce boundary", async () => {
        vi.useFakeTimers();
        const fs = adapter(), changed = vi.fn(), createWatcher = vi.fn(() => fs.transport);
        const watcher = createGitWorkspaceWatcher({ createWatcher, onWorkspaceChanged: changed, onError: vi.fn() });
        await watcher.subscribe(subscription("editor-session"));
        await watcher.subscribe(subscription("review-session"));
        fs.emit("change");
        fs.emit("change");
        expect(createWatcher).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(299);
        expect(changed).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(changed).toHaveBeenCalledExactlyOnceWith(["editor-session", "review-session"]);
        await watcher.dispose();
    });
    it.each([false, true])("retains a shared handle until every consumer releases duplicate-session=%s", async (duplicate) => {
        const fs = adapter();
        const watcher = createGitWorkspaceWatcher({ createWatcher: () => fs.transport, onWorkspaceChanged: vi.fn(), onError: vi.fn() });
        await watcher.subscribe(subscription("editor-session"));
        await watcher.subscribe(subscription(duplicate ? "editor-session" : "review-session"));
        await watcher.unsubscribe("editor-session");
        expect(fs.transport.close).not.toHaveBeenCalled();
        await watcher.unsubscribe(duplicate ? "editor-session" : "review-session");
        expect(fs.transport.close).toHaveBeenCalledTimes(1);
    });
    it("filters dependency, build and Git object noise while keeping HEAD, index and refs", () => {
        const ignored = createCodeGitIgnoredPredicate(subscription("filter-session"));
        for (const relative of ["node_modules/pkg/entry.js", ".git/objects/ab/object", "release/win/app.asar", "release-check/win/app.asar", "release-check-fc/win/app.asar", ".worktrees/branch/src/entry.ts", "tmp/draft.txt"])
            expect(ignored(join(workspace, relative))).toEqual(true);
        for (const relative of [".git/HEAD", ".git/index", ".git/refs/heads/trunk"])
            expect(ignored(join(workspace, relative))).toEqual(false);
    });
});
function observation(delay = 80) {
    let phase = "initial";
    const events: NativeEventEvidence[] = [];
    const delivered: Array<{
        id?: number;
        sequences: number[];
    }> = [];
    const errors = vi.fn();
    const changed = vi.fn((_sessions: readonly string[]) => {
        const id = events.at(-1)?.fireId;
        delivered.push({ id, sequences: events.filter(entry => entry.stage === "fire" && entry.fireId === id).map(entry => entry.sequence) });
    });
    const watcher = createGitWorkspaceWatcher({ debounceMs: delay, onWorkspaceChanged: changed, onError: errors, diagnostics: { phase: () => phase, record: entry => { events.push(entry); } } });
    const filtered = (directory: string) => {
        const known = events.filter(entry => entry.stage === "native" && entry.candidate !== null && (entry.candidate === directory || entry.candidate.startsWith(directory + sep)));
        const unknown = events.some(entry => entry.stage === "native" && entry.phase === phase && entry.classification === "UNCLASSIFIED");
        expect(known.length !== 0 || unknown).toEqual(true);
        for (const entry of known) {
            expect([entry.classification, entry.ignored]).toEqual(["IGNORED", true]);
            expect(events.filter(candidate => candidate.sequence === entry.sequence)).toEqual([entry]);
        }
    };
    const chains = () => {
        expect(errors).not.toHaveBeenCalled();
        const fired = events.filter(entry => entry.stage === "fire");
        expect(new Set(fired.map(entry => entry.fireId)).size).toEqual(changed.mock.calls.length);
        for (const entry of fired) {
            const lifecycle = events.filter(candidate => candidate.sequence === entry.sequence);
            expect(lifecycle.map(candidate => candidate.stage)).toEqual(["native", "schedule", "fire"]);
            expect(entry.classification).not.toBe("IGNORED");
            expect(lifecycle[1].scheduleId).toEqual(entry.scheduleId);
        }
        for (const notification of delivered) {
            expect(notification.id).toBeDefined();
            expect(notification.sequences.length).toBeGreaterThan(0);
        }
    };
    return { events, watcher, changed, errors, filtered, chains, phase: (value: string) => { phase = value; }, fired: async (file: string) => vi.waitFor(() => expect(events.some(entry => entry.stage === "fire" && entry.phase === phase && (entry.candidate === file || entry.classification === "UNCLASSIFIED"))).toEqual(true)) };
}
it("validates diagnostic provenance for unknown events and refuses wrongly classified object events", async () => {
    const recorder = observation();
    recorder.phase("unknown-filename");
    const root = resolve("diagnostic-fixture");
    const unknown: NativeEventEvidence = { sequence: 17, timestamp: 23, recordedAt: 23, phase: "unknown-filename", eventType: "change", filename: null, filenameType: "null", classification: "UNCLASSIFIED", candidate: null, ignored: null, watchRoot: root, stage: "native" };
    const objects = join(root, ".git", "objects");
    expect(() => recorder.filtered(objects)).toThrow();
    recorder.events.push(unknown, { ...unknown, stage: "schedule", scheduleId: 4 }, { ...unknown, stage: "fire", scheduleId: 4, fireId: 6 });
    recorder.changed(["diagnostic-session"]);
    await recorder.fired(join(root, "entry.ts"));
    recorder.filtered(objects);
    recorder.chains();
    recorder.events.push({ ...unknown, sequence: 18, filename: "object-id", filenameType: "string", candidate: join(objects, "object-id"), classification: "MEANINGFUL", ignored: false });
    expect(() => recorder.filtered(objects)).toThrow();
    await recorder.watcher.dispose();
});
const native = it.runIf(process.platform === "win32" || process.platform === "darwin");
describe("native filesystem notifications", () => {
    native("correlates source and HEAD notifications while rejecting dependency and object noise", async () => {
        const root = mkdtempSync(join(tmpdir(), "watch-native-contract-")), gitDir = join(root, ".git"), recorder = observation();
        mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
        writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/trunk\n");
        try {
            await recorder.watcher.subscribe({ sessionId: "native-session", workspaceRoot: root, gitDir });
            await pause(200);
            recorder.phase("source");
            const source = join(root, "entry.ts");
            writeFileSync(source, "export {};");
            await pause(400);
            await recorder.fired(source);
            expect(recorder.changed).toHaveBeenCalledWith(["native-session"]);
            recorder.phase("dependency");
            mkdirSync(join(root, "node_modules", "fixture"), { recursive: true });
            writeFileSync(join(root, "node_modules", "fixture", "index.js"), "fixture");
            await pause(400);
            recorder.filtered(join(root, "node_modules"));
            recorder.phase("objects");
            mkdirSync(join(gitDir, "objects", "ab"), { recursive: true });
            writeFileSync(join(gitDir, "objects", "ab", "object"), "object data");
            await pause(400);
            recorder.filtered(join(gitDir, "objects"));
            recorder.phase("head");
            writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/topic\n");
            await pause(400);
            await recorder.fired(join(gitDir, "HEAD"));
            recorder.chains();
            await recorder.watcher.dispose();
            const count = recorder.changed.mock.calls.length;
            writeFileSync(join(root, "after-dispose.txt"), "closed");
            await pause(100);
            expect(recorder.changed).toHaveBeenCalledTimes(count);
        }
        finally {
            await recorder.watcher.dispose();
            await pause(100);
            rmSync(root, { recursive: true, force: true });
        }
    });
    native("watches metadata outside the worktree along with worktree source files", async () => {
        const base = mkdtempSync(join(tmpdir(), "external-git-watch-")), root = join(base, "checkout"), gitDir = join(base, "metadata", ".git"), recorder = observation();
        mkdirSync(root);
        mkdirSync(join(gitDir, "refs", "heads"), { recursive: true });
        writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/trunk\n");
        try {
            await recorder.watcher.subscribe({ sessionId: "worktree-session", workspaceRoot: root, gitDir });
            await pause(200);
            recorder.phase("external-head");
            writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/topic\n");
            await pause(400);
            await recorder.fired(join(gitDir, "HEAD"));
            recorder.phase("source");
            writeFileSync(join(root, "module.ts"), "export {};");
            await pause(400);
            await recorder.fired(join(root, "module.ts"));
            recorder.chains();
        }
        finally {
            await recorder.watcher.dispose();
            await pause(100);
            rmSync(base, { recursive: true, force: true });
        }
    });
    native("closes all handles so subsequent writes cannot notify", async () => {
        const root = mkdtempSync(join(tmpdir(), "closed-watch-contract-")), gitDir = join(root, ".git"), recorder = observation();
        mkdirSync(gitDir);
        try {
            await recorder.watcher.subscribe({ sessionId: "closed-session", workspaceRoot: root, gitDir });
            await recorder.watcher.dispose();
            await pause(100);
            writeFileSync(join(root, "later.ts"), "later");
            await pause(400);
            expect(recorder.changed).not.toHaveBeenCalled();
        }
        finally {
            await recorder.watcher.dispose();
            rmSync(root, { recursive: true, force: true });
        }
    });
    it.runIf(process.platform === "win32")("resolves short Windows paths for worktree and external metadata handles", async (context) => {
        const base = mkdtempSync(join(tmpdir(), "watch contract long folder ")), recorder = observation(20);
        try {
            if (!process.env.ComSpec)
                throw new Error("ComSpec is required for the Windows short-path fixture");
            const { stdout } = await promisify(execFile)(process.env.ComSpec, ["/d", "/s", "/c", 'for %Q in ("%FIREFLY_CONTRACT_WATCH_ROOT%") do @echo %~fsQ'], { env: { ...process.env, FIREFLY_CONTRACT_WATCH_ROOT: base }, encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true, signal: context.signal, timeout: 5000 });
            const short = stdout.trim();
            expect(realpathSync.native(short)).toEqual(realpathSync.native(base));
            if (short === base)
                context.skip("The fixture volume does not provide an 8.3 alias");
            const root = join(short, "checkout"), gitDir = join(short, "git-metadata");
            mkdirSync(root);
            mkdirSync(gitDir);
            await recorder.watcher.subscribe({ sessionId: "short-session", workspaceRoot: root, gitDir });
            recorder.phase("short-source");
            writeFileSync(join(root, "source.txt"), "sample");
            await recorder.fired(join(root, "source.txt"));
            recorder.phase("short-head");
            writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/trunk\n");
            await recorder.fired(join(gitDir, "HEAD"));
            recorder.phase("short-ignored");
            mkdirSync(join(root, "node_modules"));
            writeFileSync(join(root, "node_modules", "ignored.txt"), "dependency");
            await pause(150);
            recorder.filtered(join(root, "node_modules"));
            await recorder.watcher.dispose();
            const count = recorder.changed.mock.calls.length;
            writeFileSync(join(root, "closed.txt"), "closed");
            await pause(150);
            expect(recorder.changed).toHaveBeenCalledTimes(count);
            recorder.chains();
            expect(recorder.errors).not.toHaveBeenCalled();
        }
        finally {
            await recorder.watcher.dispose();
            rmSync(base, { recursive: true, force: true });
        }
    }, 15000);
});
