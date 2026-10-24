import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { logger, setLogLevel, type LogEntry } from "../shared/logger";
import { formatTs, createFileLogSink, rotateIfNeeded, installFileLogSink } from "./log-sink-file";
let root: string;
beforeEach(() => {
    root = fs.mkdtempSync(join(tmpdir(), "file-log-contract-"));
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
const timestamp = new Date(2027, 1, 6, 4, 5, 3, 9).getTime();
function entry(message: string): LogEntry { return { ts: timestamp, level: "info", tag: "Contract", message, line: `INFO Contract ${message}` }; }
const read = (file: string) => fs.readFileSync(file, "utf8");
describe("local log records", () => {
    it("pads every local timestamp component", () => {
        expect(formatTs(timestamp)).toEqual("2027-02-06 04:05:03.009");
        expect(formatTs(new Date(2027, 10, 24, 17, 36, 42, 831).getTime())).toEqual("2027-11-24 17:36:42.831");
    });
    it("appends timestamped records in arrival order and tolerates missing parent directories", () => {
        const file = join(root, "records.log");
        const sink = createFileLogSink(file);
        sink(entry("record-alpha"));
        sink(entry("record-beta"));
        expect(read(file).split("\n")).toEqual(["2027-02-06 04:05:03.009 INFO Contract record-alpha", "2027-02-06 04:05:03.009 INFO Contract record-beta", ""]);
        expect(() => createFileLogSink(join(root, "absent", "records.log"))(entry("unwritable"))).not.toThrow();
    });
    it("automatically rotates before the next append after the size limit", () => {
        const file = join(root, "records.log");
        const sink = createFileLogSink(file, 40);
        sink(entry("first-large-record"));
        sink(entry("following-record"));
        expect(fs.existsSync(file + ".1")).toEqual(true);
        expect(read(file + ".1")).toContain("first-large-record");
        expect(read(file)).toContain("following-record");
    });
});
describe("rotation generations", () => {
    it("does nothing for a nonexistent file", () => {
        const file = join(root, "absent.log");
        expect(() => rotateIfNeeded(file, 64)).not.toThrow();
        expect(fs.existsSync(file + ".1")).toEqual(false);
    });
    it("retains exactly two backups while rotating oversized files", () => {
        const file = join(root, "rolling.log");
        fs.writeFileSync(file, "z".repeat(100));
        rotateIfNeeded(file, 50);
        expect(fs.existsSync(file + ".1")).toEqual(true);
        expect(read(file + ".1")).toHaveLength(100);
        for (let generation = 0; generation < 5; generation++) {
            fs.writeFileSync(file, String(generation).repeat(100));
            rotateIfNeeded(file, 50);
        }
        expect(fs.existsSync(file + ".1")).toEqual(true);
        expect(fs.existsSync(file + ".2")).toEqual(true);
        expect(fs.existsSync(file + ".3")).toEqual(false);
    });
});
describe("shared logger subscription", () => {
    it("writes to the profile log until uninstalled", () => {
        const uninstall = installFileLogSink(root);
        const file = join(root, "logs", "firefly.log");
        try {
            setLogLevel("info");
            logger.info("Contract", "subscription active");
            expect(fs.existsSync(file)).toEqual(true);
            expect(read(file)).toContain("subscription active");
        }
        finally {
            uninstall();
        }
        const previous = read(file);
        logger.info("Contract", "subscription removed");
        expect(read(file)).toEqual(previous);
    });
    it("rotates through the real logger and remains writable afterward", () => {
        const uninstall = installFileLogSink(root, 80);
        const file = join(root, "logs", "firefly.log");
        try {
            setLogLevel("info");
            for (let i = 0; i < 5; i++)
                logger.info("Contract", `generation-${i}-${"r".repeat(70)}`);
            expect(fs.existsSync(file + ".1")).toEqual(true);
            expect(read(file + ".1")).toContain("generation-3");
            expect(fs.existsSync(file + ".2")).toEqual(true);
            expect(read(file + ".2")).toContain("generation-2");
            expect(read(file)).toContain("generation-4");
            logger.info("Contract", "continued writing");
            expect(read(file)).toContain("continued writing");
        }
        finally {
            uninstall();
        }
    });
});
