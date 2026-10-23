// Reuse the existing history helper's PE verifier; never execute an unverified artifact here.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyHelper } from "./history-helpers.mjs";
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
export async function verifyWorkspaceHelper(directory = path.join(repoRoot, "native", "target", "release")) {
  try { return await verifyHelper(path.resolve(directory, "firefly-workspace.exe")); }
  catch (error) {
    if (error instanceof Error && error.message.startsWith("History helper ")) {
      throw new Error(error.message.replace(/^History helper /, "Workspace helper "), { cause: error });
    }
    throw error;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  verifyWorkspaceHelper(process.argv[2]).then(result => console.log(`[workspace-helper] verified ${result.helperPath} (${result.size} bytes)`))
    .catch(error => { console.error(`[workspace-helper] ${error.message}`); process.exitCode = 1; });
}
