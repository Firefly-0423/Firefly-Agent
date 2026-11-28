// Run-owned performance timing; returning an IPC ACK does not close the trace.
import { AsyncLocalStorage } from "node:async_hooks";
import { debugLog, debugWarn } from "./agent-log";

const PREFIX = "[Perf]";
interface PhaseMark { name: string; start: number; end: number }
interface TurnState { start: number; label: string; phases: PhaseMark[]; closed: boolean }
const scope = new AsyncLocalStorage<PerfTrace>();

export class PerfTrace {
  private turn?: TurnState;

  beginTurn(label = ""): void {
    if (this.turn && !this.turn.closed) {
      debugWarn(`${PREFIX} previous turn "${this.turn.label}" not dumped, auto-dumping before new turn`);
      this.dump();
    }
    this.turn = { start: Date.now(), label, phases: [], closed: false };
    debugLog(`${PREFIX} ===== TURN START${label ? ` (${label})` : ""} =====`);
  }

  begin(name: string): { end: (extra?: string) => void } {
    const turn = this.turn;
    if (!turn || turn.closed) return { end() {} };
    const start = Date.now();
    let ended = false;
    debugLog(`${PREFIX} >>> ${name} t+${start - turn.start}ms`);
    return {
      end(extra) {
        if (ended || turn.closed) return;
        ended = true;
        const end = Date.now();
        turn.phases.push({ name, start, end });
        debugLog(`${PREFIX} <<< ${name} elapsed=${end - start}ms t+${end - turn.start}ms${extra ? ` ${extra}` : ""}`);
      },
    };
  }

  async track<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const timer = this.begin(name);
    try {
      // Retained callbacks may enter from outside their original async context.
      return await scope.run(this, fn);
    } finally {
      timer.end();
    }
  }

  mark(name: string): void {
    if (!this.turn || this.turn.closed) return;
    debugLog(`${PREFIX} --- ${name} t+${Date.now() - this.turn.start}ms`);
  }

  dump(): void {
    const turn = this.turn;
    if (!turn || turn.closed) return;
    turn.closed = true;
    const total = Date.now() - turn.start;
    debugLog(`${PREFIX} ===== TURN SUMMARY (total=${total}ms)${turn.label ? ` (${turn.label})` : ""} =====`);
    if (turn.phases.length === 0) {
      debugLog(`${PREFIX}   (no phases recorded)`);
    } else {
      for (const phase of turn.phases) {
        const elapsed = phase.end - phase.start;
        const pct = total > 0 ? ((elapsed / total) * 100).toFixed(1) : "0.0";
        debugLog(`${PREFIX}   ${phase.name.padEnd(48)} ${String(elapsed).padStart(6)}ms  (${pct}%)`);
      }
    }
    debugLog(`${PREFIX} ===== END SUMMARY =====`);
    turn.phases = [];
  }
}

const legacyTrace = new PerfTrace();
const current = (): PerfTrace => scope.getStore() ?? legacyTrace;

export const perf = {
  // Completion is explicit: fn may return before the observable completes.
  withTurn<T>(fn: (trace: PerfTrace) => T): T {
    const trace = new PerfTrace();
    return scope.run(trace, () => fn(trace));
  },
  beginTurn(label = ""): void { current().beginTurn(label); },
  begin(name: string): { end: (extra?: string) => void } { return current().begin(name); },
  track<T>(name: string, fn: () => Promise<T>): Promise<T> { return current().track(name, fn); },
  mark(name: string): void { current().mark(name); },
  dump(): void { current().dump(); },
};
