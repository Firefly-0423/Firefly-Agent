import { PluginError } from "../../../shared/plugin-protocol";
import type { ToolRisk } from "./types";

/** Stable `reason` the renderer reads to tell this refusal from other ERR_PERMISSION failures. */
export const UNATTENDED_APPROVAL_UNSUPPORTED_REASON = "unattended_approval_unsupported";

/** History reason recorded when a fire is skipped because it would need an approval nobody can give yet. */
export const UNATTENDED_APPROVAL_UNSUPPORTED_SKIP_REASON = "unattended run needs approval (not supported in 1.2.0)";

/**
 * Firefly 1.2.0 has no UI to approve an unattended run, so a plugin task whose tools need approval
 * (shell, fs-write, input-control) cannot be confirmed, enabled or run on a schedule.
 * The code is an existing PluginErrorCode so the shared protocol stays unchanged; `reason` tells the cases apart.
 */
export class UnattendedApprovalUnsupportedError extends PluginError {
  readonly reason = UNATTENDED_APPROVAL_UNSUPPORTED_REASON;
  constructor(readonly blockingRisks: readonly ToolRisk[]) {
    super(
      "ERR_PERMISSION",
      `This task needs approval each time it runs (${blockingRisks.join(", ")}). Firefly 1.2.0 can't approve unattended runs yet, so it can't be confirmed.`,
    );
  }
}
