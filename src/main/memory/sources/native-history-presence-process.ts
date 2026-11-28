import { spawn } from "node:child_process";
import path from "node:path";
import type { PresenceEndpoint, PresenceSession } from "./native-history-coverage";

const MAX_FRAME = 8192;
/** Main-only, explicit helper location; no resolver, shell, renderer or root DTO. */
export function createNativeHistoryPresenceEndpoint(helperPath: string): PresenceEndpoint {
  if (!path.isAbsolute(helperPath) || path.basename(helperPath).toLowerCase() !== "firefly-history-presence.exe") {
    throw new Error("PRESENCE_INVALID_HELPER");
  }
  return {
    async open(root, deadlineMs, signal) {
      if (signal.aborted) throw new Error("PRESENCE_CANCELLED");
      if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30000) throw new Error("PRESENCE_INVALID_BUDGET");
      const child = spawn(helperPath, ["--root", root, "--parent-pid", String(process.pid), "--deadline-ms", String(deadlineMs)], {
        shell: false, windowsHide: true, cwd: path.dirname(helperPath), stdio: ["pipe", "pipe", "pipe"],
      });
      let waiter: { resolve(value: unknown): void; reject(error: Error): void } | undefined;
      let failure: Error | undefined;
      let closing = false, closed = false;
      let tail = Buffer.alloc(0);
      let confirmExit!: () => void;
      const exited = new Promise<void>((resolve) => { confirmExit = resolve; });
      let closePromise: Promise<void> | undefined;
      const close = (): Promise<void> => {
        if (closePromise) return closePromise;
        closing = true;
        closePromise = (async () => {
          if (!closed) {
            // Cancellation is only sent over the private pipe. The exact ChildProcess
            // is forcibly stopped if it does not cooperate, and close confirms exit.
            if (child.stdin.writable) child.stdin.end('{"type":"cancel","version":1}\n');
            const kill = setTimeout(() => {
              if (!closed) { try { child.kill(); } catch { /* Exit is still unconfirmed; the cleanup deadline rejects. */ } }
            }, 200);
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([exited, new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error("PRESENCE_CLEANUP_FAILED")), 800);
              })]);
            } finally { clearTimeout(kill); if (timeout) clearTimeout(timeout); }
          }
          // A protocol fault after a resolved frame invalidates the measurement
          // even when the exact process subsequently exits without an OS error.
          if (failure?.message === "PRESENCE_PROTOCOL_FAILED") throw failure;
        })();
        return closePromise;
      };
      const fail = (code: string): void => {
        failure ??= new Error(code);
        const pending = waiter; waiter = undefined;
        pending?.reject(failure);
        void close().catch(() => {});
      };
      const abort = (): void => fail("PRESENCE_CANCELLED");
      const next = (): Promise<unknown> => {
        if (failure) return Promise.reject(failure);
        if (closed || closing) return Promise.reject(new Error("PRESENCE_PROCESS_FAILED"));
        if (waiter) return Promise.reject(new Error("PRESENCE_BUSY"));
        return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
      };
      const ready = next();
      signal.addEventListener("abort", abort, { once: true });
      child.once("error", () => fail("PRESENCE_PROCESS_FAILED"));
      child.stdin.on("error", () => { if (!closing) fail("PRESENCE_PROCESS_FAILED"); });
      // Drain diagnostic stderr without retaining or publishing paths/native details.
      child.stderr.on("data", () => {});
      for (const pipe of [child.stdout, child.stderr]) pipe.on("error", () => { if (!closing) fail("PRESENCE_PROCESS_FAILED"); });
      child.once("close", () => {
        closed = true; signal.removeEventListener("abort", abort);
        if (waiter) fail("PRESENCE_PROCESS_FAILED");
        confirmExit();
      });
      child.stdout.on("data", (chunk: Buffer) => {
        if (closing) return;
        let offset = 0;
        while (offset < chunk.length) {
          if (!waiter) { fail("PRESENCE_PROTOCOL_FAILED"); return; }
          const newline = chunk.indexOf(10, offset);
          const end = newline === -1 ? chunk.length : newline;
          if (tail.length + end - offset > MAX_FRAME) { fail("PRESENCE_PROTOCOL_FAILED"); return; }
          tail = Buffer.concat([tail, chunk.subarray(offset, end)]);
          if (newline === -1) return;
          let frame: unknown;
          try { frame = JSON.parse(tail.toString("utf8")); } catch { fail("PRESENCE_PROTOCOL_FAILED"); return; }
          tail = Buffer.alloc(0);
          if (!waiter) { fail("PRESENCE_PROTOCOL_FAILED"); return; }
          const pending = waiter; waiter = undefined; pending.resolve(frame);
          offset = newline + 1;
        }
      });
      const event = (value: unknown, type: string, keys: string): Record<string, unknown> => {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("PRESENCE_PROTOCOL_FAILED");
        const frame = value as Record<string, unknown>;
        if (frame.type === "error" && frame.version === 1 && Object.keys(frame).sort().join(",") === "code,type,version" && typeof frame.code === "string") {
          throw new Error("PRESENCE_NATIVE_FAILED");
        }
        if (frame.type !== type || frame.version !== 1 || Object.keys(frame).sort().join(",") !== keys) throw new Error("PRESENCE_PROTOCOL_FAILED");
        return frame;
      };
      try {
        const frame = await ready;
        if (failure) throw failure;
        event(frame, "ready", "type,version");
      } catch (error) {
        if (error instanceof Error && error.message === "PRESENCE_PROTOCOL_FAILED") fail("PRESENCE_PROTOCOL_FAILED");
        await close(); throw error;
      }
      return {
        async probe(ids, probeSignal) {
          if (probeSignal.aborted || signal.aborted) throw new Error("PRESENCE_CANCELLED");
          if (!Array.isArray(ids) || ids.length === 0 || ids.length > 32 || ids.some((id) => typeof id !== "string")) throw new Error("PRESENCE_INVALID_BATCH");
          if (waiter) throw new Error("PRESENCE_BUSY");
          const command = JSON.stringify({ type: "probe", version: 1, sessionIds: ids });
          if (Buffer.byteLength(command, "utf8") > 32768) throw new Error("PRESENCE_INVALID_BATCH");
          const reply = next();
          probeSignal.addEventListener("abort", abort, { once: true });
          try {
            child.stdin.write(command + "\n", (error) => { if (error) fail("PRESENCE_PROCESS_FAILED"); });
            const value = await reply;
            if (failure) throw failure;
            const frame = event(value, "results", "observations,type,version");
            if (!Array.isArray(frame.observations) || frame.observations.length !== ids.length) throw new Error("PRESENCE_PROTOCOL_FAILED");
            if (failure) throw failure;
            return frame.observations;
          } catch (error) {
            if (error instanceof Error && error.message === "PRESENCE_PROTOCOL_FAILED") fail("PRESENCE_PROTOCOL_FAILED");
            throw error;
          } finally { probeSignal.removeEventListener("abort", abort); }
        },
        close,
      } satisfies PresenceSession;
    },
  };
}
