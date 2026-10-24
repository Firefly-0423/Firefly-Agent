import fs from "node:fs";

/** Test-only probe: zombies have exited; stopped/sleeping tasks still require killing. */
export function isPidExecuting(pid, {
  probe = (value) => process.kill(value, 0),
  platform = process.platform,
  readStat = (value) => fs.readFileSync(`/proc/${value}/stat`, "utf8"),
} = {}) {
  if (pid == null) return false;
  try { probe(pid); }
  catch (error) { return error.code !== "ESRCH"; }
  if (platform === "linux") {
    try {
      // comm may itself contain parentheses. The state follows its final closing parenthesis.
      const state = /^\d+ \([\s\S]*\) ([A-Z])(?: |$)/.exec(readStat(pid))?.[1];
      if (state === "Z" || state === "X") return false;
    } catch { /* Inaccessible state cannot prove that execution stopped. */ }
  }
  return true;
}
