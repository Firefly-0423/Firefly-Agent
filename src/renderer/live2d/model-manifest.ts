export interface MotionManifestEntry {
  Name?: string;
  File?: string;
  [key: string]: unknown;
}

export interface MotionManifestShape {
  FileReferences?: {
    Motions?: Record<string, MotionManifestEntry[]>;
    Expressions?: Array<{ Name: string; File: string }>;
  };
}

/**
 * Resolve author-provided names when present. Firefly's manifest does not
 * name motion entries, so its exact array ordinal is the stable identifier
 * already used by the original Firefly action catalog.
 */
export function buildMotionIndexMap(json: MotionManifestShape): Map<string, Map<string, number>> {
  const output = new Map<string, Map<string, number>>();
  for (const [group, entries] of Object.entries(json.FileReferences?.Motions ?? {})) {
    const byName = new Map<string, number>();
    entries.forEach((entry, index) => {
      const exactName = typeof entry?.Name === "string" && entry.Name.length > 0
        ? entry.Name
        : String(index);
      byName.set(exactName, index);
    });
    output.set(group, byName);
  }
  return output;
}
