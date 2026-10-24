interface CacheEntry<T> { value: T; at: number }
export class TtlResultCache<T> {
  private readonly records = new Map<string, CacheEntry<T>>();
  constructor(private readonly ttlMs: number, private readonly maxEntries = 100) {}
  get(key: string): CacheEntry<T> | null {
    const saved = this.records.get(key);
    if (saved) {
      if (Date.now() - saved.at >= this.ttlMs) {
        this.records.delete(key);
      } else {
        return saved;
      }
    }
    return null;
  }
  set(key: string, value: T): void {
    if (this.records.size >= this.maxEntries) this.records.clear();
    const saved = { value, at: Date.now() };
    this.records.set(key, saved);
  }
  clear(): void { this.records.clear(); }
}
