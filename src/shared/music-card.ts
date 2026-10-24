export type MusicCardTrack = {
  coverUrl?: string; album?: string; artists: string[]; name: string; id: string;
};
export type MusicCardData = {
  tracks: MusicCardTrack[]; source: "daily_recommendation" | "search"; setId: string;
};

function readTrack(candidate: unknown): MusicCardTrack[] {
  if (!candidate || typeof candidate !== "object") return [];
  const fields = candidate as Record<string, unknown>;
  if (typeof fields.id !== "string" || !fields.id || typeof fields.name !== "string" || !fields.name) return [];
  return [{ id: fields.id, name: fields.name,
    artists: Array.isArray(fields.artists) ? fields.artists.filter((entry): entry is string => typeof entry === "string") : [],
    album: typeof fields.album === "string" ? fields.album : undefined,
    coverUrl: typeof fields.coverUrl === "string" ? fields.coverUrl : undefined }];
}
export function normalizeMusicCardData(value: unknown): MusicCardData | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { setId?: unknown; source?: unknown; tracks?: unknown };
  if (typeof candidate.setId !== "string" || !candidate.setId) return null;
  if (candidate.source !== "daily_recommendation" && candidate.source !== "search") return null;
  if (!Array.isArray(candidate.tracks)) return null;
  const songs = candidate.tracks.flatMap(readTrack).slice(0, 5);
  return songs.length === 0 ? null : { setId: candidate.setId, source: candidate.source, tracks: songs };
}
