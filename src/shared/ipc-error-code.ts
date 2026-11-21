/**
 * Electron wraps an error thrown by an `ipcMain.handle` handler as
 * "Error invoking remote method '<channel>': Error: <message>". Main throws public failure codes as the
 * whole message, so the renderer only recovers a message that is a bare code in this exact form.
 * The code still has to be in the public failure vocabulary before it is shown.
 */
const WRAPPED_CODE = /^Error invoking remote method '[^']{1,128}': Error: ([A-Z][A-Z0-9_]{2,63})$/;

export function unwrapIpcErrorCode(error: unknown): unknown {
  const message = error instanceof Error ? error.message : undefined;
  const match = message === undefined ? null : WRAPPED_CODE.exec(message);
  return match ? new Error(match[1]) : error;
}
