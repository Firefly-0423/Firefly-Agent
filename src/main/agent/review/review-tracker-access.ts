import { app } from "electron";
import { getRunReviewTracker } from "./run-review-tracker";

/** 写入工具共用的审阅追踪器入口：userData 目录只在这里读取一次。 */
export function reviewTrackerFor() {
  return getRunReviewTracker(app.getPath("userData"));
}
