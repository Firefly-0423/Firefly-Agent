import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const output = vi.hoisted(() => ({ csv: vi.fn(() => "result.csv"), stats: vi.fn(), lines: vi.fn(), bars: vi.fn() }));
vi.mock("./render/csv-export", () => ({ exportCsv: output.csv }));
vi.mock("./render/ascii-line-chart", () => ({ renderLineCharts: output.lines }));
vi.mock("./render/ascii-bars", () => ({ renderBars: output.bars }));
vi.mock("./render/stats", async original => ({ ...await original<typeof import("./render/stats")>(), printStats: output.stats }));
const argv = process.argv;
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.spyOn(console, "log").mockImplementation(() => {}); process.argv = ["node", "dmae-sim"]; });
afterEach(() => { process.argv = argv; vi.restoreAllMocks(); });
it("defaults to coffee, captures every round and renders all outputs", async () => {
  await import("./dmae-sim"); const [result, directory] = output.csv.mock.calls[0] as unknown as [any, string]; expect(directory).toBe(path.join(process.cwd(), "sim-result", "v3.4")); expect(result.rounds.length).toBeGreaterThan(0); expect(result.snapshots).toHaveLength(result.rounds.length); expect(result.snapshots.every((r: any[]) => r.length === result.entries.length)).toBe(true); expect(result.stats.totalRounds).toBe(result.rounds.length); expect(output.stats).toHaveBeenCalledWith(result); expect(output.lines).toHaveBeenCalledWith(result); expect(output.bars).toHaveBeenCalledWith(result);
});
it.each(["mix", "rescue"])("accepts %s scenario and numeric overrides in both flag syntaxes", async scenario => {
  process.argv.push(`--scenario=${scenario}`, "--outputDir", "chosen", "--alpha=2", "--beta", "0.4", "--wakeGamma=0.8", "--modelRewardBase=3", "--wakeLambda=0.6", "--threshold=25", "--userRewardBase=12", "--no-charts", "--no-bars", "--ignored"); await import("./dmae-sim");
  expect(output.csv.mock.calls[0]).toEqual([expect.objectContaining({ params: expect.objectContaining({ decayAlpha: 2, decayBeta: 0.4, wakeGamma: 0.8, modelRewardBase: 3, wakeLambda: 0.6, promptThreshold: 25, userRewardBase: 12 }) }), "chosen"]); expect(output.lines).not.toHaveBeenCalled(); expect(output.bars).not.toHaveBeenCalled();
});
it("sweeps finite values without writing output files", async () => {
  process.argv.push("--scenario=mix", "--userRewardBase=3,bad,7"); await import("./dmae-sim"); expect(output.csv).not.toHaveBeenCalled(); expect(output.stats).not.toHaveBeenCalled(); const log = vi.mocked(console.log).mock.calls.map(c => c.join(" ")).join("\n"); expect(log).toContain("[3, 7]"); expect(log).toContain("avgLife(I=45)"); expect(log).not.toContain("NaN");
});
it.each(["missing", "toString", "__proto__"])("rejects unknown scenario %s", async scenario => { process.argv.push(`--scenario=${scenario}`); await expect(import("./dmae-sim")).rejects.toThrow(`Unknown scenario: ${scenario}`); expect(output.csv).not.toHaveBeenCalled(); });
