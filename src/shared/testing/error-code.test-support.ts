/**
 * 测试专用：精确匹配稳定错误码。
 *
 * `toThrow("CODE")` 是子串匹配，产品把码改成更长的名字（例如 `CODE_FALLBACK`）或在消息后面拼了别的文字时，
 * 断言照样通过。产品的错误消息本身就是错误码（`throw Error("MEMORY_...")`），所以用 `^CODE$` 精确比较整条消息：
 *
 *   expect(() => run()).toThrow(exactly("MEMORY_INPUT_INVALID"));
 *   await expect(promise).rejects.toThrow(exactly("MEMORY_SOURCE_STALE"));
 */
export function exactly(code: string): RegExp {
  if (!/^[A-Z][A-Z0-9_]*$/.test(code)) throw new Error(`exactly() expects a stable error code, got ${JSON.stringify(code)}`);
  return new RegExp(`^${code}$`);
}
