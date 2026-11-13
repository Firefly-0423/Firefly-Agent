const managed = new WeakSet<object>();
const guards = new WeakMap<object, (url: string) => boolean>();
/** Only the Main native factory registers an exact contents identity. */
export function registerBrowserGuestRouting(contents: object, allows: (url: string) => boolean): () => void {
  managed.add(contents); guards.set(contents, allows);
  return () => { guards.delete(contents); };
}
/** Existing global navigation guard delegates exact guests and never opens externally. */
export function routeBrowserGuestNavigation(contents: object, event: { preventDefault(): void }, url: string): boolean {
  if (!managed.has(contents)) return false;
  let allowed = false;
  try { allowed = guards.get(contents)?.(url) === true; } catch { /* deny */ }
  if (!allowed) event.preventDefault();
  return true;
}
