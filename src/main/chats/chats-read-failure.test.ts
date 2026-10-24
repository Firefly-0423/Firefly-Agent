import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ directory: "" }));
vi.mock("electron", () => ({ app: { getPath: () => state.directory }, shell: { openPath: vi.fn() } }));
beforeEach(() => {
  vi.resetModules();
  state.directory = fs.mkdtempSync(path.join(os.tmpdir(), "firefly-history-test-"));
  fs.mkdirSync(path.join(state.directory, "firefly-chats", "sessions"), { recursive: true });
});
afterEach(() => fs.rmSync(state.directory, { recursive: true, force: true }));
const index = () => path.join(state.directory, "firefly-chats", "index.json");

it.each([undefined, "[]"])("distinguishes absent and genuine empty history: %s", async (contents) => {
  if (contents !== undefined) fs.writeFileSync(index(), contents);
  const store = await import("./chats-store");
  store.initialize();
  expect(store.listSessions({ mode: "chat" })).toEqual([]);
  expect(store.listSessions({ mode: "work" })).toEqual([]);
  if (contents === undefined) expect(fs.existsSync(index())).toBe(false);
  else expect(fs.readFileSync(index(), "utf8")).toBe(contents);
});

it.each(["{broken", "null", "{}", "[{}]"])("rejects corrupt history without overwriting it: %s", async (contents) => {
  fs.writeFileSync(index(), contents);
  const store = await import("./chats-store");
  store.initialize();
  expect(() => store.listSessions({ mode: "chat" })).toThrow("CHAT_HISTORY_READ_FAILED");
  expect(() => store.listSessions({ mode: "work" })).toThrow("CHAT_HISTORY_READ_FAILED");
  expect(() => store.createSession({ mode: "chat" })).toThrow("CHAT_HISTORY_READ_FAILED");
  expect(() => store.deleteSession("test")).toThrow("CHAT_HISTORY_READ_FAILED");
  expect(fs.readFileSync(index(), "utf8")).toBe(contents);
  expect(fs.readdirSync(path.dirname(index())).sort()).toEqual(["index.json", "sessions"]);
  expect(fs.readdirSync(path.join(path.dirname(index()), "sessions"))).toEqual([]);
});

it("rejects a filesystem read error without replacing the entry", async () => {
  fs.mkdirSync(index());
  const store = await import("./chats-store");
  store.initialize();
  expect(() => store.listSessions()).toThrow("CHAT_HISTORY_READ_FAILED");
  expect(() => store.createSession({ mode: "chat" })).toThrow("CHAT_HISTORY_READ_FAILED");
  expect(fs.statSync(index()).isDirectory()).toBe(true);
});

it("preserves the index and corrupt session instead of normalizing from missing data", async () => {
  const store = await import("./chats-store");
  store.initialize();
  const session = store.createSession({ mode: "chat" });
  const contents = fs.readFileSync(index(), "utf8");
  const file = path.join(path.dirname(index()), "sessions", `${session.id}.json`);
  fs.writeFileSync(file, "{broken");
  vi.resetModules();
  const reloaded = await import("./chats-store");
  reloaded.initialize();
  expect(reloaded.listSessions()).toHaveLength(1);
  expect(() => reloaded.getSession(session.id)).toThrow("CHAT_SESSION_READ_FAILED");
  expect(fs.readFileSync(index(), "utf8")).toBe(contents);
  expect(fs.readFileSync(file, "utf8")).toBe("{broken");
});
