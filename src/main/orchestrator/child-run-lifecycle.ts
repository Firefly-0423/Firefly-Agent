import type { RunExecutionCoordinator } from "./harness/execution-coordinator";

/** Drain this child's genuine leaves, then invoke the existing canonical closure. */
export async function settleChildExecution(input: {
  coordinator: RunExecutionCoordinator;
  childRunId: string;
  close: () => Promise<void>;
}): Promise<void> {
  await input.coordinator.whenChildSettled(input.childRunId);
  await input.close();
}
