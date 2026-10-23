import path from "node:path";
import { AtomicJsonStore } from "../atomic-json-store";
import type { StoredBrowserToolSettings } from "./browser-tools-hub";

const DEFAULTS: StoredBrowserToolSettings = Object.freeze({ askWhereToSave: false, folder: null });

function valid(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => key !== "askWhereToSave" && key !== "folder")) return false;
  if (typeof v.askWhereToSave !== "boolean") return false;
  return v.folder === null || (typeof v.folder === "string" && v.folder.length > 0 && v.folder.length <= 1024 && path.isAbsolute(v.folder));
}

/** Browser tool settings kept in one small JSON file. A missing or unreadable file means the defaults; a failed write
 * keeps the new value for this run and never overwrites a file it could not read. */
export function createBrowserToolSettingsStore(file: string) {
  const store = new AtomicJsonStore<StoredBrowserToolSettings>(file, valid);
  let current: StoredBrowserToolSettings;
  try { current = { ...store.read(DEFAULTS) }; } catch { current = { ...DEFAULTS }; }
  return Object.freeze({
    get: (): StoredBrowserToolSettings => ({ ...current }),
    update(patch: Partial<StoredBrowserToolSettings>): StoredBrowserToolSettings {
      const next = { ...current, ...patch };
      if (!valid(next)) return { ...current };
      current = next;
      try { store.write(current); } catch { /* persisting is best effort */ }
      return { ...current };
    },
  });
}
