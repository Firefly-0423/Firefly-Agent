import {test} from "node:test";
import assert from "node:assert/strict";
import {vitestArguments} from "./run-tests.mjs";
test("explicit JSON/verbose reporters retain the required archive reporter",()=>{const args=vitestArguments(["--reporter=verbose","--reporter=json","--outputFile=synthetic-report.json"]);assert.ok(args.includes("--reporter=verbose"));assert.ok(args.includes("--reporter=json"));assert.ok(args.some(a=>a.startsWith("--reporter=")&&a.endsWith("archive-reporter.mjs")));assert.equal(args[0],"run")});
test("ordinary npm test keeps console output and filtered arguments",()=>{const args=vitestArguments(["src/main/runtime-profile.test.ts"]);assert.ok(args.includes("--reporter=default"));assert.ok(args.includes("src/main/runtime-profile.test.ts"));assert.ok(args.some(a=>a.endsWith("archive-reporter.mjs")))});
