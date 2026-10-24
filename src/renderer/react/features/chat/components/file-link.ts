export type FileLinkTarget = {
  lineEnd?: number;
  lineStart?: number;
  absPath: string;
};

function slashPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/([A-Za-z]:)/, "$1");
}

export function parseFileLinkHref(href: string): FileLinkTarget | null {
  if (!href.startsWith("file:///")) return null;
  const separator = href.indexOf("#");
  const pathPart = separator >= 0 ? href.slice(0, separator) : href;
  const anchor = separator >= 0 ? href.slice(separator + 1) : "";
  let unescaped = pathPart;
  try { unescaped = decodeURIComponent(pathPart); } catch { unescaped = pathPart; }
  const path = slashPath(unescaped.slice("file://".length));
  if (!path) return null;
  const location: FileLinkTarget = { absPath: path };
  const lines = /^L(\d+)(?:-L?(\d+))?$/.exec(anchor);
  if (lines) {
    location.lineStart = Number(lines[1]);
    location.lineEnd = lines[2] ? Number(lines[2]) : location.lineStart;
  }
  return location;
}

export function relativePathInsideWorkspace(absPath: string, workspaceRoot: string): string | null {
  function comparisonPath(value: string) {
    const slashes = slashPath(value).replace(/\/{2,}/g, "/");
    const trimmed = slashes.length > 1 && slashes.endsWith("/") ? slashes.slice(0, -1) : slashes;
    return trimmed.toLowerCase();
  }
  const candidate = comparisonPath(absPath);
  const directory = comparisonPath(workspaceRoot);
  if (!directory) return null;
  if (candidate === directory) return ".";
  return candidate.startsWith(directory + "/") ? slashPath(absPath).slice(directory.length + 1) : null;
}
