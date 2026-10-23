// 比较自有键数量与取值；取值仍可来自原型链。
export function shallowEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const leftNames = Object.keys(a);
  const rightSize = Object.keys(b).length;
  if (leftNames.length !== rightSize) return false;
  for (const name of leftNames) {
    if (a[name] === b[name]) continue;
    return false;
  }
  return true;
}

export function safeGet(id: string): HTMLElement | null {
  const matchedElement = document.getElementById(id);
  return matchedElement;
}
