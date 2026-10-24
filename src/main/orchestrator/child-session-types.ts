import type { TaskWriteEvidence, ModelExecutionEvent } from "../../shared/agent-execution-evidence";
import type { RunExecutionCoordinator } from "./harness/execution-coordinator";
import type { ModelExecutionRecorder } from "./harness/model-execution-evidence";

import type { TaskSessionStatus } from "../../shared/task-session";
import type { HarnessInput } from "./harness/types";
import type { ToolDefinition } from "./tools/registry/tool-registry";
import type { VendorConfig } from "./vendors/types";
import type { RunCapabilities } from "./run-capabilities";
import type { ToolOutputStore } from "./harness/tool-output/tool-output-store";

export interface ChildSessionResult {
  taskId: string;
  status: TaskSessionStatus;
  text: string;
  writes?: TaskWriteEvidence[];
  executionEvents?: ModelExecutionEvent[];
  error?: { code: string; message: string };
}

export interface DelegationScope { groupId: string; toolCallId: string }

export interface ChildSessionParent {
  /** Trusted process-local coordination. These are never model or IPC arguments. */
  executionCoordinator?: RunExecutionCoordinator;
  groupId?: string;
  modelExecutionRecorder?: ModelExecutionRecorder;
  /** Main-owned capabilities only; parent IDs never confer memory read permission. */
  backgroundMemory?: import("../memory-context/background-memory-ingress").BackgroundMemoryHost;
  memoryRun?: import("../memory-context/main-memory-runtime").MainMemoryRun;
  parentConversationId: string;
  parentRunId: string;
  mode: "work" | "code";
  systemPrompt: string;
  vendorConfig: VendorConfig;
  tools: ToolDefinition[];
  capabilities?: RunCapabilities;
  resolvedWorkspaceRoot?: string;
  signal?: AbortSignal;
  checkPermission?: HarnessInput["checkPermission"];
  includeInteractiveTools?: boolean;
  permissionMode?: import("./firefly-agent").FireflyRunOptions["permissionMode"];
  fileAccessLevel?: import("../permission-policy").AgentFileAccessLevel;
  toolOutputStore?: ToolOutputStore;
  revalidateToolPermission?: import("./tools/registry/tool-context").ToolContext["revalidateToolPermission"];
  workReadScopes?: import("../../shared/chat-types").WorkReadScope[];
}
