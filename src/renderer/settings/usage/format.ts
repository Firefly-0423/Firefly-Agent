// 用量历史页的纯函数：数字缩写、图例占比、按天堆叠。不碰 DOM，便于单测。

/** 图例与柱段的分类色板；最后一格留给"其他"。 */
export const USAGE_PALETTE = ["#6366F1", "#14B8A6", "#F59E0B", "#3B82F6", "#8B5CF6", "#10B981", "#F97316"] as const;
export const OTHER_COLOR = "#94A3B8";
/** 最多单独着色的分类数；其余合并成"其他"。 */
export const MAX_LEGEND_ITEMS = USAGE_PALETTE.length;

/** 1234 → 1.2k，1_500_000 → 1.5M；整千整百万不带小数（1000k 记作 1M）。 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const units: Array<[number, string]> = [[1e9, "B"], [1e6, "M"], [1e3, "k"]];
  for (const [size, suffix] of units) {
    if (value < size) continue;
    const scaled = value / size;
    const rounded = scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
    // 999.96k rounds up to 1000k, which reads better as 1M.
    if (rounded >= 1000 && suffix !== "B") return formatTokens(rounded * size);
    return `${rounded}${suffix}`;
  }
  return String(Math.round(value));
}

export interface LegendRow {
  name: string;
  tokens: number;
  /** 占总量的整数百分比；总量为 0 时为 0。 */
  share: number;
  color: string;
  /** 合并出来的"其他"，名字由界面按语言给。 */
  isOther?: boolean;
}

/** 取用量最大的若干类上色，其余合并成"其他"；占比按最大余数法凑成 100，避免图例加起来 99% 或 101%。 */
export function legendRows(items: ReadonlyArray<{ name: string; tokens: number }>, limit = MAX_LEGEND_ITEMS): LegendRow[] {
  const sorted = items.filter(item => item.tokens > 0).sort((left, right) => right.tokens - left.tokens);
  const head = sorted.slice(0, limit);
  const rest = sorted.slice(limit).reduce((sum, item) => sum + item.tokens, 0);
  const rows: LegendRow[] = head.map((item, index) => ({ name: item.name, tokens: item.tokens, share: 0, color: USAGE_PALETTE[index % USAGE_PALETTE.length]! }));
  if (rest > 0) rows.push({ name: "", tokens: rest, share: 0, color: OTHER_COLOR, isOther: true });
  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  if (total <= 0) return rows;
  const exact = rows.map(row => (row.tokens / total) * 100);
  const floors = exact.map(Math.floor);
  let remainder = 100 - floors.reduce((sum, value) => sum + value, 0);
  const order = exact.map((value, index) => ({ index, fraction: value - floors[index]! })).sort((left, right) => right.fraction - left.fraction);
  for (const { index } of order) {
    if (remainder <= 0) break;
    floors[index]! += 1;
    remainder -= 1;
  }
  rows.forEach((row, index) => { row.share = floors[index]!; });
  return rows;
}

export interface StackSegment {
  name: string;
  tokens: number;
  color: string;
}

/** 把一天的各分类用量按图例顺序排成从下到上的柱段；不在图例里的并入"其他"。 */
export function stackSegments(byName: Readonly<Record<string, number>>, legend: readonly LegendRow[]): StackSegment[] {
  const colored = new Map(legend.filter(row => !row.isOther).map(row => [row.name, row]));
  const segments: StackSegment[] = legend.filter(row => !row.isOther).map(row => ({ name: row.name, tokens: byName[row.name] ?? 0, color: row.color }));
  const other = Object.entries(byName).filter(([name]) => !colored.has(name)).reduce((sum, [, tokens]) => sum + tokens, 0);
  const otherRow = legend.find(row => row.isOther);
  if (otherRow && other > 0) segments.push({ name: "", tokens: other, color: otherRow.color });
  return segments.filter(segment => segment.tokens > 0);
}

/** 纵轴取整的上限：1、2、5 × 10^n，至少够放下最大值。 */
export function niceMax(value: number): number {
  if (!Number.isFinite(value) || value <= 1) return 1;
  const exponent = Math.pow(10, Math.floor(Math.log10(value)));
  for (const step of [1, 2, 5, 10]) if (value <= step * exponent) return step * exponent;
  return 10 * exponent;
}
