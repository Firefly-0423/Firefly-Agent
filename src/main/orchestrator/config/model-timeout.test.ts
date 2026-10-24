import {describe,expect,it} from "vitest";
import {
 DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
 MAX_MODEL_REQUEST_TIMEOUT_MS,
 MIN_MODEL_REQUEST_TIMEOUT_MS,
 normalizeModelRequestTimeoutMs,
 resolveModelRequestTimeoutMs,
 resolveModelTimeout,
 resolveTotalBudgetMs,
} from "./model-timeout";

describe("normalizeModelRequestTimeoutMs",()=>{
 it("falls back to the default for non-positive and non-finite values",()=>{
  expect(normalizeModelRequestTimeoutMs(0)).toBe(DEFAULT_MODEL_REQUEST_TIMEOUT_MS);
  expect(normalizeModelRequestTimeoutMs(-1)).toBe(DEFAULT_MODEL_REQUEST_TIMEOUT_MS);
  expect(normalizeModelRequestTimeoutMs(Number.NaN)).toBe(DEFAULT_MODEL_REQUEST_TIMEOUT_MS);
  expect(normalizeModelRequestTimeoutMs(Infinity)).toBe(DEFAULT_MODEL_REQUEST_TIMEOUT_MS);
  expect(normalizeModelRequestTimeoutMs(undefined)).toBe(DEFAULT_MODEL_REQUEST_TIMEOUT_MS);
  expect(normalizeModelRequestTimeoutMs("not a number")).toBe(DEFAULT_MODEL_REQUEST_TIMEOUT_MS);
 });
 it("clamps to the inclusive minimum and maximum",()=>{
  expect(normalizeModelRequestTimeoutMs(1)).toBe(MIN_MODEL_REQUEST_TIMEOUT_MS);
  expect(normalizeModelRequestTimeoutMs(MIN_MODEL_REQUEST_TIMEOUT_MS)).toBe(MIN_MODEL_REQUEST_TIMEOUT_MS);
  expect(normalizeModelRequestTimeoutMs(MAX_MODEL_REQUEST_TIMEOUT_MS)).toBe(MAX_MODEL_REQUEST_TIMEOUT_MS);
  expect(normalizeModelRequestTimeoutMs(MAX_MODEL_REQUEST_TIMEOUT_MS+1)).toBe(MAX_MODEL_REQUEST_TIMEOUT_MS);
 });
 it("rounds numeric strings and fractional numbers",()=>{
  expect(normalizeModelRequestTimeoutMs("30000.6")).toBe(30001);
  expect(normalizeModelRequestTimeoutMs(20_000.4)).toBe(20_000);
 });
});

describe("resolveModelRequestTimeoutMs",()=>{
 it("uses the default when settings are absent or zero",()=>{
  expect(resolveModelRequestTimeoutMs()).toBe(DEFAULT_MODEL_REQUEST_TIMEOUT_MS);
  expect(resolveModelRequestTimeoutMs({})).toBe(DEFAULT_MODEL_REQUEST_TIMEOUT_MS);
  expect(resolveModelRequestTimeoutMs({modelRequestTimeoutSec:0})).toBe(DEFAULT_MODEL_REQUEST_TIMEOUT_MS);
 });
 it("converts seconds to milliseconds and applies the same clamps",()=>{
  expect(resolveModelRequestTimeoutMs({modelRequestTimeoutSec:30})).toBe(30_000);
  expect(resolveModelRequestTimeoutMs({modelRequestTimeoutSec:5})).toBe(MIN_MODEL_REQUEST_TIMEOUT_MS);
  expect(resolveModelRequestTimeoutMs({modelRequestTimeoutSec:1200})).toBe(MAX_MODEL_REQUEST_TIMEOUT_MS);
 });
});

describe("resolveTotalBudgetMs",()=>{
 it("multiplies by at least one attempt",()=>{
  expect(resolveTotalBudgetMs(10_000,3)).toBe(30_000);
  expect(resolveTotalBudgetMs(10_000,0)).toBe(10_000);
  expect(resolveTotalBudgetMs(10_000,-2)).toBe(10_000);
  expect(resolveTotalBudgetMs(10_000,1)).toBe(10_000);
 });
});

describe("resolveModelTimeout",()=>{
 it("returns both the per-attempt timeout and total budget",()=>{
  expect(resolveModelTimeout({modelRequestTimeoutSec:60},2)).toEqual({perAttemptTimeoutMs:60_000,totalBudgetMs:120_000});
  expect(resolveModelTimeout(undefined,0)).toEqual({perAttemptTimeoutMs:DEFAULT_MODEL_REQUEST_TIMEOUT_MS,totalBudgetMs:DEFAULT_MODEL_REQUEST_TIMEOUT_MS});
 });
});
