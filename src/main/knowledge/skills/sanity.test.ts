import { expect, test } from "vitest";

test("the test runner evaluates assertions", async () => {
  const numbers = await Promise.resolve([1, 1]);
  expect(numbers.reduce((sum, value) => sum + value, 0)).toEqual(2);
  expect(numbers).toHaveLength(2);
});
