import { describe, expect, it } from "vitest";
import { dropZoneAt, gridPlacement, movePanel, reconcileColumns, resizeColumns, resizeRows, shiftPanel, MIN_COLUMN_WIDTH, MIN_PANE_HEIGHT, dockEdge, edgeGuideBox } from "./panel-layout";

const cols = (...groups: string[][]) => groups.map(ids => ({ ids, weight: 1 }));
const ids = (columns: { ids: string[] }[]) => columns.map(column => column.ids);

it("puts newly opened panels in a column of their own at the end and drops closed ones", () => {
  expect(ids(reconcileColumns(cols(["a", "b"], ["c"]), ["a", "c", "d"]))).toEqual([["a"], ["c"], ["d"]]);
  expect(ids(reconcileColumns([], ["a", "b"]))).toEqual([["a"], ["b"]]);
});

it("moves a panel beside another (new column) or into its column above or below", () => {
  expect(ids(movePanel(cols(["a"], ["b"], ["c"]), "c", "a", "left"))).toEqual([["c"], ["a"], ["b"]]);
  expect(ids(movePanel(cols(["a"], ["b"], ["c"]), "a", "c", "right"))).toEqual([["b"], ["c"], ["a"]]);
  expect(ids(movePanel(cols(["a"], ["b"], ["c"]), "a", "c", "bottom"))).toEqual([["b"], ["c", "a"]]);
  expect(ids(movePanel(cols(["a", "b"], ["c"]), "b", "c", "top"))).toEqual([["a"], ["b", "c"]]);
  expect(ids(movePanel(cols(["a"], ["b"]), "a", "a", "left"))).toEqual([["a"], ["b"]]);
});

it("steps one place with the keyboard and stays put at the edge", () => {
  expect(ids(shiftPanel(cols(["a"], ["b"], ["c"]), "a", "right"))).toEqual([["b"], ["a"], ["c"]]);
  expect(ids(shiftPanel(cols(["a"], ["b"]), "a", "left"))).toEqual([["a"], ["b"]]);
  expect(ids(shiftPanel(cols(["a", "b"]), "b", "up"))).toEqual([["b", "a"]]);
  expect(ids(shiftPanel(cols(["a", "b"]), "b", "right"))).toEqual([["a"], ["b"]]);
});

it("resizes a pair of columns in pixels and never below the minimum", () => {
  const next = resizeColumns(cols(["a"], ["b"], ["c"]), 0, [300, 300, 200], 340);
  expect(next.map(column => column.weight)).toEqual([340, 260, 200]);
  expect(resizeColumns(cols(["a"], ["b"]), 0, [300, 300], 5).map(column => column.weight)).toEqual([MIN_COLUMN_WIDTH, 600 - MIN_COLUMN_WIDTH]);
});

it("places columns on odd tracks and splits shared rows evenly", () => {
  const { rows, byId } = gridPlacement(cols(["a", "b"], ["c"]));
  expect(rows).toBe(2);
  expect(byId.get("b")).toEqual({ column: 1, row: 2, span: 1 });
  expect(byId.get("c")).toEqual({ column: 3, row: 1, span: 2 });
});

it("treats the outer thirds of a panel as beside it and the middle as above or below", () => {
  const box = { left: 0, top: 0, width: 100, height: 100 };
  expect([dropZoneAt(box, 10, 50), dropZoneAt(box, 90, 50), dropZoneAt(box, 50, 20), dropZoneAt(box, 50, 80)]).toEqual(["left", "right", "top", "bottom"]);
});

it("lets each column keep its own panel heights in one shared grid", () => {
  const { tracks, byId } = gridPlacement([{ ids: ["a", "b"], weight: 1, heights: { a: 300, b: 100 } }, { ids: ["c", "d"], weight: 1 }]);
  // Cuts at 0.5 (right column) and 0.75 (left column) make three rows.
  expect(tracks).toEqual([0.5, 0.25, 0.25]);
  expect(byId.get("a")).toEqual({ column: 1, row: 1, span: 2 });
  expect(byId.get("b")).toEqual({ column: 1, row: 3, span: 1 });
  expect(byId.get("c")).toEqual({ column: 3, row: 1, span: 1 });
  expect(byId.get("d")).toEqual({ column: 3, row: 2, span: 2 });
});

it("resizes two stacked panels in pixels and never below the minimum height", () => {
  const columns = [{ ids: ["a", "b", "c"], weight: 1 }];
  expect(resizeRows(columns, 0, 0, [200, 200, 100], 260)[0]!.heights).toEqual({ a: 260, b: 140, c: 100 });
  expect(resizeRows(columns, 0, 1, [200, 200, 100], 400)[0]!.heights).toEqual({ a: 200, b: 300 - MIN_PANE_HEIGHT, c: MIN_PANE_HEIGHT });
});

it("drops a moved panel's height from its old column and gives it the average in the new one", () => {
  const moved = movePanel([{ ids: ["a", "b"], weight: 1, heights: { a: 300, b: 100 } }, { ids: ["c"], weight: 1 }], "b", "c", "bottom");
  expect(moved[0]).toEqual({ ids: ["a"], weight: 1, heights: { a: 300 } });
  expect(gridPlacement(moved).byId.get("b")).toEqual({ column: 3, row: 2, span: 1 });
});

describe("dockEdge", () => {
  const columns = [{ ids: ["a"], weight: 1 }, { ids: ["b", "c"], weight: 1 }, { ids: ["d"], weight: 1 }];

  it("is the left side only for the first column and the right side only for the last", () => {
    expect(dockEdge(columns, "d", "a", "left")).toBe("left");
    expect(dockEdge(columns, "a", "d", "right")).toBe("right");
    expect(dockEdge(columns, "d", "b", "left")).toBeNull();
    expect(dockEdge(columns, "a", "b", "right")).toBeNull();
  });

  it("is the top or bottom side only for the first or last panel of a column", () => {
    expect(dockEdge(columns, "a", "b", "top")).toBe("top");
    expect(dockEdge(columns, "a", "c", "bottom")).toBe("bottom");
    expect(dockEdge(columns, "a", "c", "top")).toBeNull();
    expect(dockEdge(columns, "a", "b", "bottom")).toBeNull();
  });

  it("treats a lone panel as both the top and the bottom of its column", () => {
    expect(dockEdge(columns, "a", "d", "top")).toBe("top");
    expect(dockEdge(columns, "a", "d", "bottom")).toBe("bottom");
  });

  it("takes the lifted panel out first, so its old neighbour can become the outermost", () => {
    // "b" is lifted; "c" is then alone in its column, hence at both the top and the bottom.
    expect(dockEdge(columns, "b", "c", "top")).toBe("top");
    // "a" is lifted: "b"/"c" become the first column.
    expect(dockEdge(columns, "a", "b", "left")).toBe("left");
    expect(dockEdge(columns, "b", "b", "left")).toBeNull();
  });
});

describe("edgeGuideBox", () => {
  const area = { left: 0, top: 0, width: 400, height: 300 };

  it("runs a vertical line down the whole left or right side, just inside the border", () => {
    expect(edgeGuideBox("left", area, { left: 8, width: 100 })).toEqual({ left: 3, top: 3, width: 2, height: 294 });
    expect(edgeGuideBox("right", area, { left: 8, width: 100 })).toEqual({ left: 395, top: 3, width: 2, height: 294 });
  });

  it("runs a horizontal line along the top or bottom side as wide as the target's column", () => {
    expect(edgeGuideBox("top", area, { left: 108, width: 120 })).toEqual({ left: 108, top: 3, width: 120, height: 2 });
    expect(edgeGuideBox("bottom", area, { left: 108, width: 120 })).toEqual({ left: 108, top: 295, width: 120, height: 2 });
  });

  it("honours inset and thickness", () => {
    expect(edgeGuideBox("left", area, { left: 0, width: 10 }, 0, 4)).toEqual({ left: 0, top: 0, width: 4, height: 300 });
  });
});
