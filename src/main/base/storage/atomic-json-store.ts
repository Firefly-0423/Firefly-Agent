import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Synchronous, single-process JSON writes; never delete the target before replace. */
export class AtomicJsonStore<T> {
  constructor(private readonly file: string, private readonly validate: (value: unknown) => boolean) {}
  private existing(): { value: T; bytes: string } | undefined {
    let bytes: string;
    try { bytes = fs.readFileSync(this.file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("ATOMIC_JSON_READ_FAILED", { cause: error }); }
    try {
      const value: unknown = JSON.parse(bytes);
      if (!this.validate(value)) throw new Error("shape");
      return { value: value as T, bytes };
    } catch (error) { throw new Error("ATOMIC_JSON_EXISTING_INVALID", { cause: error }); }
  }
  read(fallback: T): T { return this.existing()?.value ?? fallback; }
  write(value: T): void {
    if (!this.validate(value)) throw new Error("ATOMIC_JSON_SHAPE_INVALID");
    const previous = this.existing(); // invalid existing data is never overwritten
    let bytes: string;
    try {
      bytes = JSON.stringify(value, null, 2);
      if (bytes === undefined || !this.validate(JSON.parse(bytes))) throw new Error("shape");
    } catch (error) { throw new Error("ATOMIC_JSON_SHAPE_INVALID", { cause: error }); }
    const directory = path.dirname(this.file);
    const temporary = path.join(directory, `.${path.basename(this.file)}.${randomUUID()}.tmp`);
    const backupTemporary = `${temporary}.backup`;
    try {
      fs.mkdirSync(directory, { recursive: true });
      // Node 24 flush uses fsyncSync before closing the descriptor.
      // https://nodejs.org/docs/latest-v24.x/api/fs.html#fswritefilesyncfile-data-options
      fs.writeFileSync(temporary, bytes, { encoding: "utf8", flag: "wx", mode: 0o600, flush: true });
      if (previous) {
        fs.writeFileSync(backupTemporary, previous.bytes, { encoding: "utf8", flag: "wx", mode: 0o600, flush: true });
        fs.renameSync(backupTemporary, `${this.file}.bak`);
      }
      fs.renameSync(temporary, this.file);
    } catch (error) {
      const failures: unknown[] = [error];
      for (const ownedTemporary of [temporary, backupTemporary]) {
        try { fs.unlinkSync(ownedTemporary); }
        catch (cleanupError) { if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") failures.push(cleanupError); }
      }
      throw new Error("ATOMIC_JSON_WRITE_FAILED", { cause: failures.length === 1 ? error : new AggregateError(failures) });
    }
  }
}
