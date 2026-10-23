import { beforeEach, afterEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelConversationBindingStore, type ExternalChannelChat } from "./conversation-binding-store";

vi.mock("node:fs", async original => ({ ...await original<typeof import("node:fs")>() }));
let directory: string;
let document: string;
const chat = (id: string, lastAt: number): ExternalChannelChat => ({
  channel: "qq", sessionId: `external-${id}`, chatId: id, chatType: "private", lastAt,
});
const reopen = (limit?: number) => new ChannelConversationBindingStore(document, limit);
beforeEach(() => {
  directory = fs.mkdtempSync(join(tmpdir(), "bindings-persistence-contract-"));
  document = join(directory, "observations.json");
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { force: true, recursive: true });
});

it("coalesces timestamp observations until the inclusive five-second write boundary", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(40_000);
  const writes = vi.spyOn(fs, "renameSync");
  const store = reopen();
  store.observe(chat("north", 10));
  for (let step = 1; step <= 100; step++) {
    clock.mockReturnValue(40_000 + step * 10);
    store.observe(chat("north", 10 + step));
  }
  expect(store.list().externalChats[0].lastAt).toEqual(110);
  expect(writes).toHaveBeenCalledTimes(1);
  expect(reopen().list().externalChats[0].lastAt).toEqual(10);
  clock.mockReturnValue(45_000);
  store.observe(chat("north", 210));
  expect(writes).toHaveBeenCalledTimes(2);
  expect(reopen().list().externalChats[0].lastAt).toEqual(210);
});

it("flushes dirty observations once and commits metadata and bindings immediately", () => {
  vi.spyOn(Date, "now").mockReturnValue(40_000);
  const store = reopen();
  store.observe(chat("north", 10));
  store.observe(chat("north", 20));
  store.flush();
  expect(reopen().list().externalChats[0].lastAt).toEqual(20);
  const writes = vi.spyOn(fs, "renameSync");
  store.flush();
  expect(writes).not.toHaveBeenCalled();
  store.observe(chat("north", 30));
  store.bind("external-north", "desktop-north");
  expect(reopen().resolve("external-north")).toEqual("desktop-north");
  expect(reopen().list().externalChats[0].lastAt).toEqual(30);
  store.unbind("external-north");
  expect(reopen().resolve("external-north")).toBeNull();
  store.observe({ ...chat("north", 40), senderName: "River" });
  expect(reopen().list().externalChats[0].senderName).toEqual("River");
});

it("writes after clock rollback and retries a failed flush without losing pending observations", () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(40_000);
  const store = reopen();
  store.observe(chat("north", 10));
  clock.mockReturnValue(39_000);
  store.observe(chat("north", 20));
  expect(reopen().list().externalChats[0].lastAt).toEqual(20);
  store.observe(chat("north", 30));
  vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("volume disconnected"); });
  expect(() => store.flush()).toThrow("volume disconnected");
  store.flush();
  expect(reopen().list().externalChats[0].lastAt).toEqual(30);
});

it("loads a durable binding and replaces it without changing other chats", () => {
  const store = reopen();
  store.observe(chat("north", 10));
  store.observe(chat("south", 11));
  store.bind("external-north", "desktop-old", 12);
  store.bind("external-south", "desktop-south", 13);
  expect(reopen().resolve("external-north")).toEqual("desktop-old");
  expect(reopen().list().bindings).toStrictEqual([
    { sessionId: "external-north", conversationId: "desktop-old", updatedAt: 12 },
    { sessionId: "external-south", conversationId: "desktop-south", updatedAt: 13 },
  ]);
  store.bind("external-north", "desktop-new", 14);
  expect(store.resolve("external-north")).toEqual("desktop-new");
  expect(store.resolve("external-south")).toEqual("desktop-south");
  expect(store.unbind("external-north")).toEqual(true);
  expect(store.resolve("external-north")).toBeNull();
  expect(store.resolve("external-south")).toEqual("desktop-south");
});

it("rejects a binding without a known external chat", () => {
  expect(() => reopen().bind("external-unseen", "desktop-any")).toThrow("Unknown external chat");
});

it("starts empty when the persisted document cannot be decoded", () => {
  fs.writeFileSync(document, "invalid document", "utf8");
  const store = reopen();
  expect(store.list()).toStrictEqual({ bindings: [], externalChats: [] });
  expect(store.resolve("external-unseen")).toBeNull();
});

it("evicts the oldest unbound observations in descending recency order", () => {
  const store = reopen(2);
  ["north", "south", "west"].forEach((id, index) => store.observe(chat(id, index + 10)));
  expect(store.list().externalChats.map(item => item.chatId)).toStrictEqual(["west", "south"]);
  expect(store.resolve("external-north")).toBeNull();
});

it("reserves space for bound chats while newer observations compete for the remaining slot", () => {
  const store = reopen(2);
  store.observe(chat("anchor", 10));
  store.bind("external-anchor", "desktop-anchor");
  store.observe(chat("visitor", 20));
  store.observe(chat("recent", 30));
  expect(store.resolve("external-anchor")).toEqual("desktop-anchor");
  expect(store.list().externalChats.map(item => item.chatId)).toStrictEqual(["recent", "anchor"]);
});

it("retains all bound chats when reopened with a smaller display limit", () => {
  const store = reopen(2);
  for (const id of ["north", "south"]) {
    store.observe(chat(id, 10));
    store.bind(`external-${id}`, `desktop-${id}`);
  }
  const restarted = reopen(1);
  expect(restarted.resolve("external-north")).toEqual("desktop-north");
  expect(restarted.resolve("external-south")).toEqual("desktop-south");
  expect(restarted.list().externalChats.map(item => item.chatId).sort()).toStrictEqual(["north", "south"]);
});
