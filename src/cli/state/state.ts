import { fireflyEnvironment } from "../../shared/firefly-environment";
import process from "node:process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

export type FirstLaunchRecord = { version: string; firstSeenAt: string };
export type StateFile = { firstLaunch?: FirstLaunchRecord };
export type FirstLaunchState =
  | { kind: "corrupt"; raw: string }
  | { kind: "missing" }
  | { kind: "present"; record: FirstLaunchRecord };

export function statePath(): string {
  const root = fireflyEnvironment(process.env, "FIREFLY_HOME") ?? os.homedir();
  return path.join(root, ".firefly", "state.json");
}

function decodeFirstLaunch(text: string): FirstLaunchState {
  const invalid: FirstLaunchState = { kind: "corrupt", raw: text };
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return invalid;
  }
  if (document === null || typeof document !== "object") return invalid;
  const candidate = (document as StateFile).firstLaunch;
  if (typeof candidate !== "object" || candidate === null) return invalid;
  if (typeof candidate.firstSeenAt !== "string") return invalid;
  if (typeof candidate.version !== "string") return invalid;
  return { kind: "present", record: candidate };
}

export function readState(): FirstLaunchState {
  let contents: string;
  try {
    contents = fs.readFileSync(statePath(), "utf8");
  } catch {
    return { kind: "missing" };
  }
  return decodeFirstLaunch(contents);
}

export function writeState(s: StateFile): void {
  const destination = statePath();
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, [JSON.stringify(s, null, 2), ""].join("\n"), "utf8");
}
