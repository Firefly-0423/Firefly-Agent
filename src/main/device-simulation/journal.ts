import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { StorageContext } from "../storage-context";
import { AtomicJsonStore } from "../atomic-json-store";
import { assertRuntimePathsOwned, canonicalPath, within } from "../runtime-profile";
import { SIMULATION_LIMITS, validJournal, type JournalState } from "./contracts";

export class SimulationJournal {
  private readonly directory: string;
  private readonly file: string;
  private readonly lease: string;
  private readonly nonce = `${process.pid}:${randomUUID()}`;
  private readonly store: AtomicJsonStore<JournalState>;
  private closed = false;
  private materialized = false;

  constructor(private readonly context: StorageContext) {
    if (!["test", "smoke"].includes(context.profile.kind) || !context.profile.isolationRoot) throw new Error("E_SIM_PROFILE");
    this.directory = path.join(context.profile.userData, "device-simulation");
    this.file = path.join(this.directory, "journal.json");
    this.lease = path.join(this.directory, "session.lock");
    this.guardPaths();
    try { fs.mkdirSync(this.directory, { recursive: true }); } catch { throw new Error("E_SIM_STORAGE"); }
    this.guardPaths();
    let descriptor: number;
    try { descriptor = fs.openSync(this.lease, "wx", 0o600); }
    catch (error) { throw new Error((error as NodeJS.ErrnoException).code === "EEXIST" ? "E_SIM_BUSY" : "E_SIM_STORAGE"); }
    try { fs.writeFileSync(descriptor, this.nonce, "utf8"); fs.fsyncSync(descriptor); }
    catch { fs.closeSync(descriptor); fs.unlinkSync(this.lease); throw new Error("E_SIM_STORAGE"); }
    fs.closeSync(descriptor);
    this.store = new AtomicJsonStore(this.file, validJournal);
    this.materialized = fs.existsSync(this.file) || fs.existsSync(this.file + ".bak");
  }
  private guardPaths(): void {
    try {
      const { profile } = this.context;
      const canonicalUser = canonicalPath(profile.userData);
      if (canonicalPath(this.context.stateRoot).toLowerCase() !== canonicalUser.toLowerCase()) throw new Error("root");
      assertRuntimePathsOwned(profile, [this.directory, this.file, this.file + ".bak", this.lease]);
      if (!within(canonicalUser, canonicalPath(this.directory))) throw new Error("escape");
      if (fs.existsSync(this.directory) && (!fs.lstatSync(this.directory).isDirectory() || fs.lstatSync(this.directory).isSymbolicLink())) throw new Error("directory");
      for (const file of [this.file, this.file + ".bak", this.lease]) {
        let stat: fs.Stats;
        try { stat = fs.lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("file");
      }
    } catch { throw new Error("E_SIM_PATH"); }
  }
  private guard(): void {
    if (this.closed) throw new Error("E_SIM_CLOSED");
    this.guardPaths();
    try { if (fs.readFileSync(this.lease, "utf8") !== this.nonce) throw new Error("lease"); }
    catch { throw new Error("E_SIM_BUSY"); }
    if (this.materialized && !fs.existsSync(this.file)) throw new Error("E_SIM_JOURNAL_INVALID");
    for (const file of [this.file, this.file + ".bak"]) {
      try { if (fs.statSync(file).size > SIMULATION_LIMITS.journalBytes) throw new Error("size"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("E_SIM_JOURNAL_INVALID"); }
    }
  }
  read(fallback: JournalState): JournalState {
    this.guard();
    try {
      const value = structuredClone(this.store.read(fallback));
      this.materialized ||= fs.existsSync(this.file);
      return value;
    }
    catch { throw new Error("E_SIM_JOURNAL_INVALID"); }
  }
  write(value: JournalState): void {
    this.guard();
    if (!validJournal(value) || Buffer.byteLength(JSON.stringify(value, null, 2)) > SIMULATION_LIMITS.journalBytes) throw new Error("E_SIM_JOURNAL_INVALID");
    try { this.store.write(value); this.materialized = true; }
    catch (error) { throw new Error((error as Error).message === "ATOMIC_JSON_EXISTING_INVALID" ? "E_SIM_JOURNAL_INVALID" : "E_SIM_STORAGE"); }
  }
  close(): void {
    if (this.closed) return;
    this.guardPaths();
    try { if (fs.readFileSync(this.lease, "utf8") !== this.nonce) throw new Error("lease"); fs.unlinkSync(this.lease); }
    catch { throw new Error("E_SIM_BUSY"); }
    this.closed = true;
  }
}
