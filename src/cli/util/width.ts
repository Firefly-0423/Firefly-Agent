/**
 * 字符串在终端中占的格数。
 * v0.9 的横幅只含 ASCII、少量制表符和 ♡，在目标等宽字体里都是 1 格，
 * 所以用 Array.from 数码点即可。这是已知的局限而非缺陷：中日韩字符占 2 格，
 * 但不出现在 v0.9 横幅里。函数起名 displayWidth，是为了以后换成
 * UAX #11（东亚宽度）实现时不必改调用方。
 */
export function displayWidth(s: string): number {
  return [...s].length;
}
