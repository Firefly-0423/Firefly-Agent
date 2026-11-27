import { describe, expect, it } from "vitest";
import {
  PLUGIN_ACTIVATE_ERROR_PREFIX,
  describeActivationFailure,
  sanitizePluginMessage,
  wrapPluginActivationError,
} from "./plugin-activation-error";
import { PluginError } from "./plugin-protocol";

describe("wrapPluginActivationError", () => {
  it("keeps the plugin's own message and drops stack lines and file paths", () => {
    const thrown = new Error("activation fails on purpose\n    at activate (C:\\Users\\bob\\plugin\\index.mjs:3:9)");
    const wrapped = wrapPluginActivationError(thrown) as PluginError;
    expect(wrapped).toBeInstanceOf(PluginError);
    expect(wrapped.code).toBe("ERR_INTERNAL");
    expect(wrapped.message).toBe(`${PLUGIN_ACTIVATE_ERROR_PREFIX}activation fails on purpose`);
  });

  it("passes a PluginError through unchanged", () => {
    const original = new PluginError("ERR_PERMISSION", "no");
    expect(wrapPluginActivationError(original)).toBe(original);
  });

  it("wraps non-Error throwables", () => {
    expect((wrapPluginActivationError("plain string") as PluginError).message).toBe(`${PLUGIN_ACTIVATE_ERROR_PREFIX}plain string`);
  });
});

describe("sanitizePluginMessage", () => {
  it.each([
    ["cannot open C:\\Users\\bob\\data\\x.json now", "cannot open <路径>"],
    ["cannot open C:\\Users\\Jane Doe\\Secret Dir\\x.json", "cannot open <路径>"],
    ["cannot open /home/bob/data/x.json now", "cannot open <路径>"],
    ["cannot open /janedoe", "cannot open <路径>"],
    ["ENOENT: no such file or directory, open 'C:\\Users\\Jane Doe\\private\\credentials.json'", "ENOENT: no such file or directory, open '<路径>"],
    ["open \"/home/Jane's Doe/private/key.pem\" failed", "open \"<路径>"],
    ["open `\\\\server\\share name\\a.txt` failed", "open `<路径>"],
    ["cannot read ~\\Jane Doe\\x", "cannot read <路径>"],
    ["cannot read %USERPROFILE%\\Jane Doe\\x", "cannot read <路径>"],
    ["cannot read $HOME/Jane Doe/x", "cannot read <路径>"],
    ["cannot read ..\\Jane Doe\\x", "cannot read <路径>"],
    ["use a/b or https://example.com instead of 1/2", "use a/b or https://example.com instead of 1/2"],
    ["bad\tinput\u0007here", "bad input here"],
  ])("sanitizes %j", (input, expected) => {
    expect(sanitizePluginMessage(input)).toBe(expected);
  });

  it("truncates at 160 characters plus an ellipsis, leaving shorter text intact", () => {
    expect(sanitizePluginMessage("a".repeat(160))).toBe("a".repeat(160));
    expect(sanitizePluginMessage("a".repeat(161))).toBe(`${"a".repeat(160)}…`);
  });
});

describe("describeActivationFailure", () => {
  it("shows the plugin's own message in Chinese framing", () => {
    expect(describeActivationFailure(new PluginError("ERR_INTERNAL", `${PLUGIN_ACTIVATE_ERROR_PREFIX}boom`))).toBe("插件自身报错：boom");
  });

  it("falls back to the generic wording when the message is only a path", () => {
    expect(describeActivationFailure(new PluginError("ERR_INTERNAL", `${PLUGIN_ACTIVATE_ERROR_PREFIX}C:\\Users\\Jane Doe\\x.js`))).toBe("插件启动时抛出了错误");
  });

  it.each([
    [new PluginError("ERR_TIMEOUT", "Plugin activation timed out"), "启动超时"],
    [new PluginError("ERR_INTERNAL", "Internal plugin error"), "插件启动失败"],
    [new Error("ENOENT C:\\secret\\path"), "插件启动失败"],
  ])("never echoes host-internal text (%#)", (error, expected) => {
    const text = describeActivationFailure(error);
    expect(text).toBe(expected);
    expect(text).not.toMatch(/ENOENT|secret|Internal plugin error/);
  });
});
