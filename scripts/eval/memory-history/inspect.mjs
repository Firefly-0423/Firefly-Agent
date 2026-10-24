// 查看一份评测结果里的逐题排名。
//   node scripts/eval/memory-history/inspect.mjs <结果.json> --mode hybrid+stop+recency [--size 250] [--granularity window] [--only-fail] [--category correction]
import fs from "node:fs";

const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.error("用法：node inspect.mjs <结果.json> --mode <方式> [--size N] [--granularity session|window] [--only-fail] [--category 类别]");
  process.exit(1);
}
const opt = {};
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith("--")) opt[rest[i].slice(2)] = rest[i + 1]?.startsWith("--") || rest[i + 1] === undefined ? true : rest[++i];

const result = JSON.parse(fs.readFileSync(file, "utf8"));
const queries = new Map(result.queries.map((q) => [q.id, q]));
const runs = result.runs.filter((r) => (!opt.size || String(r.size) === String(opt.size)) && (!opt.granularity || r.granularity === opt.granularity));
if (!opt.mode) {
  console.error("可用方式：" + [...new Set(result.runs.flatMap((r) => r.rows.map((x) => x.mode)))].join(", "));
  process.exit(1);
}

for (const run of runs) {
  console.log(`\n## 粒度=${run.granularity} 规模=${run.size} 方式=${opt.mode}`);
  console.log("题目 | 类别 | 状态 | 标准答案名次 | 前三名 | 问题");
  for (const row of run.rows.filter((r) => r.mode === opt.mode)) {
    const q = queries.get(row.query);
    if (opt.category && q.category !== opt.category) continue;
    const gold = q.gold ?? [];
    const rank = gold.length ? row.ranked.findIndex((id) => gold.includes(id)) + 1 : null;
    const failed = gold.length > 0 && (row.status !== "ok" || rank === 0 || rank > 1);
    if (opt["only-fail"] && !failed) continue;
    const order = q.newer ? ` 更正:${row.order === 1 ? "新在前" : "旧在前或缺失"}` : "";
    console.log(`${q.id} | ${q.category} | ${row.status} | ${gold.length ? (rank > 0 ? rank : "未命中") : "无答案"}${order} | ${row.ranked.slice(0, 3).join(" > ") || "-"} | ${q.text}`);
  }
}
