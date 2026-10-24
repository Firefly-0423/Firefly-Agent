import { defineConfig } from "vitest/config";
import ordinary from "../../vitest.config";

/** Explicit native zero-write/cancellation acceptance; ordinary test results do not replace this gate. */
export default defineConfig({
  ...ordinary,
  test: {
    ...ordinary.test,
    include: ["src/main/memory-sources/native-history-zero-write.acceptance.ts"],
  },
});
