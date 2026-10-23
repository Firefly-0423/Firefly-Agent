import assert from "node:assert/strict";
import test from "node:test";
import { sandboxTools } from "./plugin-fixture.mjs";

async function tools() {
  const { call, tools: registry } = await sandboxTools("timezone-tools");
  return {
    canonicalize: zone => call("timezone-tools_canonicalize", { zone }),
    convert: args => call("timezone-tools_convert", args),
    run: (id, args) => registry.get(id).execute(args),
  };
}

test("canonicalize follows the deepseek-harness wire profile: UTC or Area/Location, no padding or abbreviations", async () => {
  const { canonicalize } = await tools();
  assert.deepEqual(await canonicalize("UTC"), { valid: true, canonical: "UTC" });
  assert.deepEqual(await canonicalize("America/New_York"), { valid: true, canonical: "America/New_York" });
  assert.deepEqual(await canonicalize("Asia/Shanghai"), { valid: true, canonical: "Asia/Shanghai" });
  // Spelling is normalized by the platform's ICU data (which spelling that is can differ between Node builds), the same answer Intl gives.
  for (const alias of ["asia/calcutta", "Asia/Kolkata", "America/Argentina/Buenos_Aires"]) {
    assert.deepEqual(await canonicalize(alias), { valid: true, canonical: new Intl.DateTimeFormat("en-US", { timeZone: alias }).resolvedOptions().timeZone });
  }
  for (const zone of ["", " UTC", "UTC ", "utc", "EST", "GMT", "PST8PDT", "Tokyo", "Asia/Nowhere", "../etc/passwd", "Area//Loc", "Asia/", "+09:00", "Asia/Tokyo\n"]) {
    const result = await canonicalize(zone);
    assert.equal(result.valid, false, JSON.stringify(zone));
    assert.equal(result.canonical, undefined);
  }
});

test("convert translates an absolute instant into a target zone with its UTC offset", async () => {
  const { convert } = await tools();
  assert.deepEqual(await convert({ time: "2026-03-08T12:00:00Z", to: "America/New_York" }), {
    instant: "2026-03-08T12:00:00.000Z",
    to: { zone: "America/New_York", local: "2026-03-08T08:00:00.000", offset: "-04:00" },
  });
  assert.deepEqual(await convert({ time: "2026-01-15T00:30:00+09:00", to: "Europe/London" }), {
    instant: "2026-01-14T15:30:00.000Z",
    to: { zone: "Europe/London", local: "2026-01-14T15:30:00.000", offset: "+00:00" },
  });
  assert.deepEqual((await convert({ time: "2026-06-01T00:00:00Z", to: "Asia/Kolkata" })).to, { zone: "Asia/Kolkata", local: "2026-06-01T05:30:00.000", offset: "+05:30" });
  assert.deepEqual((await convert({ time: "2026-06-01T00:00:00.123456Z", to: "UTC" })).to, { zone: "UTC", local: "2026-06-01T00:00:00.123", offset: "+00:00" });
  assert.deepEqual((await convert({ time: "2026-06-01 10:00+0200", to: "UTC" })).instant, "2026-06-01T08:00:00.000Z");
});

test("convert interprets a local wall time only with an explicit source zone", async () => {
  const { convert } = await tools();
  assert.deepEqual(await convert({ time: "2026-07-01T15:00:00", from: "Asia/Tokyo", to: "America/Los_Angeles" }), {
    instant: "2026-07-01T06:00:00.000Z",
    from: { zone: "Asia/Tokyo", local: "2026-07-01T15:00:00.000", offset: "+09:00" },
    to: { zone: "America/Los_Angeles", local: "2026-06-30T23:00:00.000", offset: "-07:00" },
  });
});

test("convert reports daylight-saving gaps as errors and folds as ambiguous, choosing the earlier instant", async () => {
  const { convert, run } = await tools();
  await assert.rejects(run("timezone-tools_convert", { time: "2026-03-08T02:30:00", from: "America/New_York", to: "UTC" }), /does not exist in America\/New_York/);
  const fold = await convert({ time: "2026-11-01T01:30:00", from: "America/New_York", to: "UTC" });
  assert.equal(fold.ambiguous, true);
  assert.equal(fold.instant, "2026-11-01T05:30:00.000Z");
  assert.deepEqual(fold.from, { zone: "America/New_York", local: "2026-11-01T01:30:00.000", offset: "-04:00" });
  assert.deepEqual(fold.alternativeInstant, "2026-11-01T06:30:00.000Z");
  const normal = await convert({ time: "2026-11-01T03:30:00", from: "America/New_York", to: "UTC" });
  assert.equal(normal.ambiguous, undefined);
  assert.equal(normal.instant, "2026-11-01T08:30:00.000Z");
});

test("convert rejects ambiguous or invalid input rather than guessing", async () => {
  const { run } = await tools();
  const bad = [
    [{ time: "2026-07-01T15:00:00", to: "UTC" }, /requires from/],
    [{ time: "2026-07-01T15:00:00Z", from: "Asia/Tokyo", to: "UTC" }, /already has an offset/],
    [{ time: "2026-07-01T15:00:00", from: "EST", to: "UTC" }, /from is not a valid zone/],
    [{ time: "2026-07-01T15:00:00Z", to: "Mars/Base" }, /to is not a valid zone/],
    [{ time: "tomorrow", to: "UTC" }, /ISO 8601/],
    [{ time: "2026-02-30T10:00:00Z", to: "UTC" }, /does not name a real date/],
    [{ time: "2026-13-01T10:00:00Z", to: "UTC" }, /does not name a real date/],
    [{ time: "2026-01-01T24:00:00Z", to: "UTC" }, /does not name a real date/],
    [{ time: "2026-01-01T10:60:00Z", to: "UTC" }, /does not name a real date/],
    [{ time: "2026-01-01T10:00:60Z", to: "UTC" }, /does not name a real date/],
    [{ time: "1850-01-01T00:00:00Z", to: "UTC" }, /between 1900 and 2200/],
    [{ time: "2300-01-01T00:00:00Z", to: "UTC" }, /between 1900 and 2200/],
    [{ time: "2026-01-01T10:00:00+25:00", to: "UTC" }, /offset/],
    [{ time: "2026-01-01", to: "UTC" }, /ISO 8601/],
  ];
  for (const [args, pattern] of bad) await assert.rejects(run("timezone-tools_convert", args), pattern, JSON.stringify(args));
});

test("rejects missing or non-string arguments instead of coercing", async () => {
  const { run } = await tools();
  for (const args of [{}, { zone: 1 }, { zone: null }, null, undefined]) await assert.rejects(run("timezone-tools_canonicalize", args), /zone must be a string/);
  for (const args of [{}, { time: 1, to: "UTC" }, { time: "2026-01-01T00:00:00Z" }, { time: "2026-01-01T00:00:00Z", to: 3 }, null, undefined]) {
    await assert.rejects(run("timezone-tools_convert", args), /time and to must be strings/);
  }
  await assert.rejects(run("timezone-tools_convert", { time: "2026-07-01T15:00:00", from: 5, to: "UTC" }), /from must be a string/);
  await assert.rejects(run("timezone-tools_canonicalize", { zone: "A/".padEnd(200, "b") }), /at most 100 characters/);
});
