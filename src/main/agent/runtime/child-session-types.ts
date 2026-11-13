import type { TaskWriteEvidence, ModelExecutionEvent } from "../../../shared/agent-execution-evidence";
import type { RunExecutionCoordinator } from "../../tooling/execution/execution-coordinator";
import type { ModelExecutionRecorder } from "../loop/model-execution-evidence";

import type { TaskSessionStatus } from "../../../shared/task-session";
import type { HarnessInput } from "../loop/types";
import type { ToolDefinition } from "../../tooling/registry/tool-registry";
import type { VendorConfig } from "../../model/providers/types";
import type { RunCapabilities } from "./run-capabilities";
import type { ToolOutputStore } from "../loop/tool-output/tool-output-store";

export interface ChildSessionResult {
  taskId: string;
  status: TaskSessionStatus;
  text: string;
  writes?: TaskWriteEvidence[];
  executionEvents?: ModelExecutionEvent[];
  error?: { code: string; message: string };
}

export interface DelegationScope { groupId: string; toolCallId: string }

interface ParentRunContext {
  parentConversationId: string;
  parentRunId: string;
  mode: "work" | "code";
  systemPrompt: string;
  vendorConfig: VendorConfig;
  tools: ToolDefinition[];
}

interface ParentAccessContext {
  capabilities?: RunCapabilities;
  resolvedWorkspaceRoot?: string;
  signal?: AbortSignal;
  checkPermission?: HarnessInput["checkPermission"];
  includeInteractiveTools?: boolean;
  permissionMode?: import("./firefly-agent").FireflyRunOptions["permissionMode"];
  fileAccessLevel?: import("../../platform/permission/permission-policy").AgentFileAccessLevel;
  toolOutputStore?: ToolOutputStore;
  revalidateToolPermission?: import("../../tooling/registry/tool-context").ToolContext["revalidateToolPermission"];
  workReadScopes?: import("../../../shared/chat-types").WorkReadScope[];
}

export interface ChildSessionParent extends ParentRunContext, ParentAccessContext {
  /** 本进程可信协调对象，不来自模型或 IPC。 */
  executionCoordinator?: RunExecutionCoordinator;
  groupId?: string;
  modelExecutionRecorder?: ModelExecutionRecorder;
  /** 仅接受 Main 持有的记忆能力；父会话 ID 本身不授予读取权限。 */
  backgroundMemory?: import("../memory-runtime/background-memory-ingress").BackgroundMemoryHost;
  memoryRun?: import("../memory-runtime/main-memory-runtime").MainMemoryRun;
}
