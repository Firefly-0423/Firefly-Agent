/** Electron forwards App certificate-error to WebContents with the SAME one-time
 * callback before application listeners. Keep both denial boundaries, answering
 * only once; weak references do not retain completed requests or native guests.
 * https://github.com/electron/electron/blob/v43.1.0/lib/browser/api/app.ts#L103-L109
 */
const denied = new WeakSet<(trusted: boolean) => void>();
export function rejectBrowserCertificate(event: { preventDefault(): void }, callback: (trusted: boolean) => void): void {
  event.preventDefault();
  if (denied.has(callback)) return;
  denied.add(callback); callback(false);
}
