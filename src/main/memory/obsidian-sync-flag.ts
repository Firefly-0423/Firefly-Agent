// 回流进行中的全局标记。单独成模块、无任何依赖，
// 这样 memory-store 可以同步读取，不必经过动态 import 引入时序差。
// 回流期间 save() 不再通知记忆变更，避免与 Obsidian 互相触发。

let importing = false;

/** importer 写回前置 true，结束后置 false */
export function setImportingMemory(v: boolean): void {
  importing = v;
}

export function isImportingMemory(): boolean {
  return importing;
}
