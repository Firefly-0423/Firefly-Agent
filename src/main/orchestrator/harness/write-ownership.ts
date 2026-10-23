import path from "node:path";
import { canonicalPath } from "../../runtime-profile";
import { ToolExecutionError } from "../tools/registry/tool-execution-error";
import type { ExecutionScope, LeafExecutionMode, LeafPermit } from "./execution-coordinator";

/** Identity only: resolves existing ancestors and appends missing suffixes.
 * It does not grant access, validate tool arguments, or create anything. */
export function canonicalWriteIdentity(value: string): string {
  return observedWriteIdentity(canonicalPath(value));
}
/** Main-owned native handle name; normalization performs no filesystem access. */
export function observedWriteIdentity(value: string): string {
  if (!path.isAbsolute(value)) throw new Error("Verified write identity must be absolute");
  const canonical = path.normalize(value);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}
export interface WriteOwnershipCoordinator {
  assertPermit(permit: LeafPermit, mode?: LeafExecutionMode): Readonly<ExecutionScope>;
  terminateChild(childRunId: string, code: "AGENT_WRITE_CONFLICT", failure?: ToolExecutionError): void;
}
interface PathOwner { agentId: string; childRunId: string }

/** Group-local role ownership, additional to the workspace-wide operation queue. */
export class WriteOwnership {
  private readonly groups = new Map<string, Map<string, PathOwner>>();
  constructor(private readonly coordinator: WriteOwnershipCoordinator) {}

  /** Call only after the leaf tool's existing authorization and validation.
   * Re-resolve every actual path under a live exclusive permit, before any mutation. */
  claim(permit: LeafPermit, paths: readonly string[], observedCanonicalPaths?: readonly string[]): void {
    const scope = this.coordinator.assertPermit(permit, "exclusive");
    if (observedCanonicalPaths && observedCanonicalPaths.length !== paths.length) throw new Error("Verified write paths must cover the entire claim");
    const identities = [...new Set(observedCanonicalPaths ? observedCanonicalPaths.map(observedWriteIdentity) : paths.map(canonicalWriteIdentity))];
    const owners = this.groups.get(scope.groupId) ?? new Map<string, PathOwner>();
    // Preflight the entire set. In particular a move claims source AND destination.
    for (const identity of identities) {
      const owner = owners.get(identity);
      if (!owner || owner.agentId === scope.agentId) continue;
      const error = new ToolExecutionError("AGENT_WRITE_CONFLICT", `Write path ${identity} is already owned by role ${owner.agentId} in group ${scope.groupId}`, "fatal", false, "not_applied");
      this.coordinator.terminateChild(scope.childRunId, "AGENT_WRITE_CONFLICT", error);
      throw error;
    }
    for (const identity of identities) owners.set(identity, { agentId: scope.agentId, childRunId: scope.childRunId });
    if (identities.length > 0) this.groups.set(scope.groupId, owners);
  }

  /** Coordinator calls only after closeGroup has drained every actual operation. */
  releaseGroup(groupId: string): void { this.groups.delete(groupId); }
}
