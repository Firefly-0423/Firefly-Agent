// 记忆设置页 DOM 引用：导入知识列表。
// ESM 静态导入保证查询在 settings.ts 顶层代码之前执行。

export const memoryImportedList = document.getElementById("memory-imported-list") as HTMLElement | null;
