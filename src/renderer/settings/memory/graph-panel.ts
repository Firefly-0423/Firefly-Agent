// 记忆关系图：d3-force 布局的 SVG。拖动节点、滚轮缩放、拖动空白处平移；Tab 在节点间移动，Enter 打开。
// 只负责画和交互，点到记忆时交给列表的同一张卡片处理（onSelect）。文字一律 textContent，不拼 HTML。
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import type { MemoryGraphLink, MemoryGraphModel, MemoryGraphNode } from "./graph-model";

type SimNode = MemoryGraphNode & SimulationNodeDatum;
type SimLink = SimulationLinkDatum<SimNode> & { kind: MemoryGraphLink["kind"] };

const SVG = "http://www.w3.org/2000/svg";
const RADIUS: Record<MemoryGraphNode["kind"], number> = { self: 22, category: 15, fact: 9, candidate: 9, source: 7, project: 8 };
const DISTANCE: Record<MemoryGraphLink["kind"], number> = { category: 90, item: 70, source: 60, project: 60 };
const LABEL_LIMIT = 18;

function motionReduced(doc: Document): boolean {
  return doc.documentElement.dataset.reduceMotion === "on" || doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}
function shorten(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > LABEL_LIMIT ? flat.slice(0, LABEL_LIMIT - 1) + "…" : flat;
}

export function createMemoryGraph(root: HTMLElement, options: { onSelect(node: MemoryGraphNode): void; label: string }) {
  const doc = root.ownerDocument;
  const svg = doc.createElementNS(SVG, "svg");
  svg.classList.add("memory-graph");
  svg.setAttribute("role", "group");
  svg.setAttribute("aria-label", options.label);
  const viewport = doc.createElementNS(SVG, "g"), edges = doc.createElementNS(SVG, "g"), vertices = doc.createElementNS(SVG, "g");
  viewport.append(edges, vertices); svg.append(viewport); root.replaceChildren(svg);

  let simulation: Simulation<SimNode, SimLink> | undefined;
  let view = { x: 0, y: 0, k: 1 }, selected: string | null = null;
  const place = () => viewport.setAttribute("transform", `translate(${view.x},${view.y}) scale(${view.k})`);

  // Wheel zooms around the pointer; dragging the background pans.
  svg.addEventListener("wheel", (event) => {
    event.preventDefault();
    const box = svg.getBoundingClientRect(), px = event.clientX - box.left, py = event.clientY - box.top;
    const k = Math.min(3, Math.max(0.4, view.k * Math.exp(-event.deltaY * 0.0015)));
    view = { k, x: px - (px - view.x) * (k / view.k), y: py - (py - view.y) * (k / view.k) }; place();
  }, { passive: false });
  svg.addEventListener("pointerdown", (event) => {
    if (event.target !== svg) return;
    const start = { x: event.clientX - view.x, y: event.clientY - view.y };
    svg.setPointerCapture(event.pointerId); svg.classList.add("is-panning");
    const move = (next: PointerEvent) => { view = { ...view, x: next.clientX - start.x, y: next.clientY - start.y }; place(); };
    const end = () => { svg.classList.remove("is-panning"); svg.removeEventListener("pointermove", move); svg.removeEventListener("pointerup", end); svg.removeEventListener("pointercancel", end); };
    svg.addEventListener("pointermove", move); svg.addEventListener("pointerup", end); svg.addEventListener("pointercancel", end);
  });

  function update(model: MemoryGraphModel) {
    simulation?.stop();
    const width = root.clientWidth || 560, height = Math.max(320, Math.min(520, width * 0.7));
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    view = { x: 0, y: 0, k: 1 }; place();
    const nodes: SimNode[] = model.nodes.map((node) => ({ ...node, ...(node.kind === "self" ? { fx: width / 2, fy: height / 2 } : {}) }));
    const links: SimLink[] = model.links.map((link) => ({ ...link }));

    const lines = links.map((link) => {
      const line = doc.createElementNS(SVG, "line");
      line.classList.add("memory-graph__edge", `is-${link.kind}`);
      return line;
    });
    edges.replaceChildren(...lines);
    const groups = nodes.map((node) => {
      const group = doc.createElementNS(SVG, "g");
      group.classList.add("memory-graph__node", `is-${node.kind}`);
      group.dataset.nodeId = node.id;
      const circle = doc.createElementNS(SVG, "circle"); circle.setAttribute("r", String(RADIUS[node.kind]));
      const text = doc.createElementNS(SVG, "text"); text.textContent = shorten(node.label);
      text.setAttribute("dy", String(RADIUS[node.kind] + 13));
      const title = doc.createElementNS(SVG, "title"); title.textContent = node.label;
      group.append(circle, text, title);
      if (node.itemId || node.kind === "source" || node.kind === "project") {
        group.setAttribute("tabindex", "0"); group.setAttribute("role", "button"); group.setAttribute("aria-label", node.label);
        const open = () => { selected = node.id; mark(); options.onSelect(node); };
        group.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } });
        drag(group, node, open);
      } else drag(group, node);
      return group;
    });
    vertices.replaceChildren(...groups);

    const draw = () => {
      links.forEach((link, i) => {
        const a = link.source as SimNode, b = link.target as SimNode;
        lines[i].setAttribute("x1", String(a.x)); lines[i].setAttribute("y1", String(a.y));
        lines[i].setAttribute("x2", String(b.x)); lines[i].setAttribute("y2", String(b.y));
      });
      nodes.forEach((node, i) => groups[i].setAttribute("transform", `translate(${node.x},${node.y})`));
    };
    simulation = forceSimulation(nodes)
      .force("link", forceLink<SimNode, SimLink>(links).id((node) => node.id).distance((link) => DISTANCE[link.kind]).strength(0.7))
      .force("charge", forceManyBody<SimNode>().strength((node) => node.kind === "self" ? -400 : -160))
      .force("center", forceCenter(width / 2, height / 2))
      .force("collide", forceCollide<SimNode>((node) => RADIUS[node.kind] + 14))
      .on("tick", draw);
    // Reduced motion: settle off screen and draw the final picture once.
    if (motionReduced(doc)) { simulation.stop(); simulation.tick(300); draw(); }

    function drag(group: SVGGElement, node: SimNode, click?: () => void) {
      group.addEventListener("pointerdown", (event) => {
        event.stopPropagation();
        const start = { x: event.clientX, y: event.clientY }; let moved = false;
        group.setPointerCapture(event.pointerId); group.classList.add("is-dragging");
        const move = (next: PointerEvent) => {
          const dx = (next.clientX - start.x) / view.k, dy = (next.clientY - start.y) / view.k;
          if (!moved && Math.hypot(dx, dy) < 3) return;
          if (!moved) { moved = true; if (!motionReduced(doc)) simulation?.alphaTarget(0.3).restart(); }
          node.fx = (node.x ?? 0) + dx; node.fy = (node.y ?? 0) + dy; start.x = next.clientX; start.y = next.clientY;
          if (motionReduced(doc)) { node.x = node.fx; node.y = node.fy; draw(); }
        };
        const end = () => {
          group.classList.remove("is-dragging");
          group.removeEventListener("pointermove", move); group.removeEventListener("pointerup", end); group.removeEventListener("pointercancel", end);
          simulation?.alphaTarget(0);
          if (node.kind !== "self") { node.fx = null; node.fy = null; }
          if (!moved) click?.();
        };
        group.addEventListener("pointermove", move); group.addEventListener("pointerup", end); group.addEventListener("pointercancel", end);
      });
    }
    function mark() { groups.forEach((group, i) => group.classList.toggle("is-selected", nodes[i].id === selected)); }
    mark();
  }

  return { update, destroy() { simulation?.stop(); } };
}
