import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { logger, getLogLevel, setLogLevel, addLogSink, removeLogSink, type LogEntry } from "./logger";
import { LogTag } from "./logger-tags";

let captured: { stdout: string; stderr: string };
let priorLevel: ReturnType<typeof getLogLevel>;
const subscriptions: Array<() => void> = [];
beforeEach(() => {
  priorLevel = getLogLevel();
  captured = { stdout: "", stderr: "" };
  vi.stubEnv("NO_COLOR", "1");
  vi.spyOn(process.stdout, "write").mockImplementation(chunk => { captured.stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation(chunk => { captured.stderr += String(chunk); return true; });
});
afterEach(() => {
  subscriptions.splice(0).forEach(cancel => cancel());
  setLogLevel(priorLevel);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("log severity routing", () => {
  it("reflects the configured level and excludes debug entries below info", () => {
    setLogLevel("info");
    expect(getLogLevel()).toEqual("info");
    logger.debug(LogTag.Firefly, "Diagnostic suppressed");
    expect(captured).toStrictEqual({ stderr: "", stdout: "" });
    logger.info(LogTag.Firefly, "Informational record");
    expect(captured.stdout).toContain("Informational record");
  });
  it("routes warning and error records exclusively to stderr", () => {
    setLogLevel("debug");
    logger.info(LogTag.Firefly, "Progress update");
    logger.warn(LogTag.Firefly, "Quota warning");
    logger.error(LogTag.Firefly, "Transport failure");
    expect(captured.stdout).toContain("Progress update");
    expect(captured.stdout).not.toContain("Quota warning");
    expect(captured.stdout).not.toContain("Transport failure");
    expect(captured.stderr).toContain("Quota warning");
    expect(captured.stderr).toContain("Transport failure");
  });
  it("does not emit informational output at warning level", () => {
    setLogLevel("warn");
    logger.info(LogTag.Firefly, "Filtered progress");
    logger.warn(LogTag.Firefly, "Visible warning");
    expect(captured.stdout).toEqual("");
    expect(captured.stderr).toContain("Visible warning");
  });
});

it("formats a padded level and tag with no time prefix", () => {
  setLogLevel("info");
  logger.info(LogTag.Skills, "Workflow loaded");
  expect(captured.stdout).not.toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} /);
  expect(captured.stdout).toMatch(/^INFO\s+/);
  expect(captured.stdout).toMatch(/Skills\s+/);
  expect(captured.stdout).toContain("Workflow loaded");
});

it("space-joins arguments and serializes structured values", () => {
  setLogLevel("info");
  logger.info(LogTag.Firefly, "phase", 7, false, { stage: "verify" });
  expect(captured.stdout).toContain('phase 7 false {"stage":"verify"}');
});

it.each(["debug", "info", "warn", "error"] as const)("keeps every declared tag within sixteen columns at level %s", level => {
  setLogLevel(level);
  Object.values(LogTag).forEach(tag => expect(tag.length).toBeLessThanOrEqual(16));
});

it("broadcasts a plain, timestamped structured entry after it passes the gate", () => {
  setLogLevel("info");
  const records: LogEntry[] = [];
  subscriptions.push(addLogSink(record => records.push(record)));
  logger.info(LogTag.Firefly, "Archive record", { sequence: 7 });
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({ tag: LogTag.Firefly, level: "info", message: 'Archive record {"sequence":7}' });
  expect(records[0].line).toContain("INFO ");
  expect(records[0].line).toContain("Archive record");
  expect(records[0].line).not.toContain("\x1b[");
  expect(typeof records[0].ts).toEqual("number");
});

it("does not broadcast entries below the configured level", () => {
  setLogLevel("warn");
  const sink = vi.fn();
  subscriptions.push(addLogSink(sink));
  logger.info(LogTag.Firefly, "Excluded record");
  expect(sink).not.toHaveBeenCalled();
});

it.each(["unsubscribe", "remove"] as const)("stops broadcasting after %s", method => {
  setLogLevel("info");
  const sink = vi.fn();
  const cancel = addLogSink(sink);
  subscriptions.push(cancel);
  if (method === "unsubscribe") cancel(); else removeLogSink(sink);
  logger.info(LogTag.Firefly, "No subscriber");
  expect(sink).not.toHaveBeenCalled();
});

it("isolates a failing sink from stream output and the remaining subscribers", () => {
  setLogLevel("info");
  const sink = vi.fn();
  subscriptions.push(addLogSink(() => { throw new Error("archive unavailable"); }), addLogSink(sink));
  expect(() => logger.info(LogTag.Firefly, "Surviving record")).not.toThrow();
  expect(sink).toHaveBeenCalledTimes(1);
  expect(captured.stdout).toContain("Surviving record");
});
