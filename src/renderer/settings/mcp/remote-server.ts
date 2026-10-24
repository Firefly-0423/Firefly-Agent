/**
 * What the "add server" box means when it holds an address instead of a command: a remote MCP server. Streamable HTTP is the
 * current transport; an address whose path ends in /sse is the legacy HTTP+SSE endpoint. Addresses the host refuses
 * (other schemes, credentials in the URL, a fragment) are not treated as remote, so they fall through to the command check.
 */
export function remoteServer(input: string): { transport: "http" | "sse"; url: string } | null {
  const text = input.trim();
  if (!/^https?:\/\//i.test(text)) return null;
  let url: URL;
  try { url = new URL(text); } catch { return null; }
  if (url.username || url.password || url.hash) return null;
  return { transport: /\/sse\/?$/i.test(url.pathname) ? "sse" : "http", url: text };
}
