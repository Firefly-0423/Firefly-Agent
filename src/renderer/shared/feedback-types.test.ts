import { it, expect, expectTypeOf } from "vitest";
import { type FeedbackApi, FEEDBACK_NOTICE_MAX_COUNT, FEEDBACK_NOTICE_DURATION_MS } from "./feedback-types";

it("exposes asynchronous decisions and a bounded three-second notice queue", () => {
  expectTypeOf<ReturnType<FeedbackApi["alert"]>>().toEqualTypeOf<Promise<void>>();
  expectTypeOf<ReturnType<FeedbackApi["confirm"]>>().toEqualTypeOf<Promise<boolean>>();
  expect({ lifetime: FEEDBACK_NOTICE_DURATION_MS, capacity: FEEDBACK_NOTICE_MAX_COUNT })
    .toStrictEqual({ lifetime: 3000, capacity: 3 });
});
