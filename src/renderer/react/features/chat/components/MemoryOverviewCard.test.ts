// @vitest-environment jsdom
import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryCardBody } from "./MemoryOverviewCard";

afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

it("draws a dot per category, lists counts and opens the full graph", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host), open = vi.fn();
  const summary = { available: true, sources: 2, categories: [{ key: "shell", facts: 1, pending: 0 }, { key: "language", facts: 0, pending: 2 }] };
  await React.act(async () => root.render(React.createElement(MemoryCardBody, { summary, onOpenGraph: open })));
  expect(host.querySelectorAll("svg.ff-memory-mini circle")).toHaveLength(3);
  expect([...host.querySelectorAll(".ff-memory-mini__count")].map(node => node.textContent)).toEqual(["1", "0 · 2 待确认"]);
  host.querySelector<HTMLButtonElement>(".ff-memory-mini__open")!.click();
  expect(open).toHaveBeenCalledOnce();
  await React.act(async () => root.render(React.createElement(MemoryCardBody, { summary: { available: true, sources: 0, categories: [] } })));
  expect(host.textContent).toBe("流萤还没记住什么。");
  await React.act(async () => root.unmount());
});
