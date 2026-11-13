import type { EntrySnapshot, SimResult } from "../sim-types";

function writeRow(snapshot: EntrySnapshot): void {
  const glyph = snapshot.state === "Active" ? "▲" : snapshot.state === "Dormant" ? "▒" : "·";
  const identifier = snapshot.entryId.length > 30 ? "…" + snapshot.entryId.slice(-28) : snapshot.entryId;
  const blocks = "█".repeat(Math.round(snapshot.activation / 2));
  console.log(`  ${glyph} ${identifier.padEnd(32)}  I=${String(snapshot.intrinsicValue).padStart(3)}  A=${snapshot.activation.toFixed(1).padStart(5)}  ${blocks}`);
}

export function renderBars(result: SimResult, sampleEvery: number = 5): void {
  console.log("\n=== ASCII 条形图（每轮快照）===");
  const visible = new Set(result.entries.filter((entry) => !entry.permanent).map((entry) => entry.id));
  const end = result.snapshots.length - 1;
  for (let position = 0; position <= end; position++) {
    if (position % sampleEvery !== 0 && position !== end) continue;
    const turn = result.rounds[position];
    const excerpt = turn.userText.slice(0, 30).replace(/\n/g, " ");
    console.log(`\n--- R${position}  user="${excerpt}"  note=${turn.note ?? ""} ---`);
    const selected = result.snapshots[position].filter((snapshot) => visible.has(snapshot.entryId))
      .sort((left, right) => right.activation - left.activation);
    for (const snapshot of selected) writeRow(snapshot);
  }
}
