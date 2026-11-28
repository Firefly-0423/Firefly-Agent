import {
  parseAndValidateSocialExtraction,
  type SocialExtractionRepairContext,
} from "./extractor";
import type { SocialAtomStore } from "./store";
import type { SocialExtractionInput } from "./types";

const LABEL = "chat-social-context";
const ATTEMPT_BUDGET = 3;
const REPAIR_SNIPPET_LIMIT = 6_000;

interface ExtractionMetric {
  outcome: "success" | "failure";
  acceptedCount: number;
  rejectedCount: number;
  attempts: number;
  repairCount: number;
}

export interface SocialContextSchedulerDeps {
  store: SocialAtomStore;
  generate: (
    input: SocialExtractionInput,
    repair?: SocialExtractionRepairContext,
  ) => Promise<string>;
  enqueue: (label: string, task: () => Promise<void>) => Promise<unknown>;
  recordMetric?: (metric: ExtractionMetric) => void;
}

export function createSocialContextScheduler(deps: SocialContextSchedulerDeps): {
  schedule(input: SocialExtractionInput): void;
} {
  const emit = (metric: ExtractionMetric): void => {
    deps.recordMetric?.(metric);
  };

  return {
    schedule(input) {
      // 闭包外层记录，供 enqueue 失败时上报最后一次的进度。
      let attemptsMade = 0;
      let repairsMade = 0;

      const extractWithRepair = async (): Promise<void> => {
        let repair: SocialExtractionRepairContext | undefined;
        for (let round = 0; round < ATTEMPT_BUDGET; round += 1) {
          attemptsMade = round + 1;
          repairsMade = round;

          const raw = await deps.generate(input, repair);
          const verdict = parseAndValidateSocialExtraction(raw, input);

          if (verdict.rejectedCount === 0) {
            deps.store.applyOperations(input.conversationId, verdict.operations, input.now);
            emit({
              outcome: "success",
              acceptedCount: verdict.operations.length,
              rejectedCount: 0,
              attempts: attemptsMade,
              repairCount: repairsMade,
            });
            return;
          }

          if (round === ATTEMPT_BUDGET - 1) {
            emit({
              outcome: "failure",
              acceptedCount: 0,
              rejectedCount: verdict.rejectedCount,
              attempts: ATTEMPT_BUDGET,
              repairCount: ATTEMPT_BUDGET - 1,
            });
            return;
          }

          repair = {
            attempt: (round + 1) as 1 | 2,
            previousOutput: raw.slice(0, REPAIR_SNIPPET_LIMIT),
            rejectedCount: verdict.rejectedCount,
          };
        }
      };

      void deps.enqueue(LABEL, extractWithRepair).catch(() => {
        emit({
          outcome: "failure",
          acceptedCount: 0,
          rejectedCount: 0,
          attempts: attemptsMade,
          repairCount: repairsMade,
        });
      });
    },
  };
}
