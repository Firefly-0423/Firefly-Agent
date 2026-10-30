// 记忆关系图：d3-force 布局的 SVG。"你"是渐变圆，类别是彩色胶囊，记忆是带类别色边的卡片胶囊（待确认为虚线），
// 来源对话和项目是带图标的小圆。拖动节点、滚轮缩放、拖动空白处平移；Tab 在节点间移动，Enter 打开；悬停时高亮整条链。
// 只负责画和交互，点到节点时交给列表的同一张卡片处理（onSelect）。文字一律 textContent，不拼 HTML。
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import type { MemoryGraphLink, MemoryGraphModel, MemoryGraphNode } from "./graph-model";

type Shape = { width: number; height: number; collide: number };
type SimNode = MemoryGraphNode & SimulationNodeDatum & { shape: Shape };
type SimLink = SimulationLinkDatum<SimNode> & { kind: MemoryGraphLink["kind"] };

const SVG = "http://www.w3.org/2000/svg";
const DISTANCE: Record<MemoryGraphLink["kind"], number> = { category: 110, item: 95, source: 80, project: 80 };
/** One hue per category, as "r g b" for rgb(var(--node-rgb) / a); mid tones that read on both themes. */
const CATEGORY_RGB: Record<string, string> = {
  language: "47 153 138", "response-style": "132 102 210", shell: "206 132 38", address: "212 86 118",
  tool: "64 124 206", preference: "70 160 90", other: "128 134 150",
};
const ICON = {
  source: "M-5 -4h10a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-5l-3 2.5v-2.5h-2a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2z",
  project: "M-6 -4h4l1.5 1.5h6.5v7.5h-12z",
};

function motionReduced(doc: Document): boolean {
  return doc.documentElement.dataset.reduceMotion === "on" || doc.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}
function shorten(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit - 1) + "…" : flat;
}
/** Width of text at `size` px without layout (jsdom has none): CJK and full-width glyphs are square, the rest about 0.55em. */
function textWidth(text: string, size: number): number {
  let width = 0;
  for (const char of text) width += /[⺀-￿]/.test(char) ? size : size * 0.56;
  return width;
}
function shapeOf(node: MemoryGraphNode, label: string): Shape {
  switch (node.kind) {
    case "self": return { width: 48, height: 48, collide: 36 };
    case "category": { const width = textWidth(label, 13) + 30; return { width, height: 28, collide: width / 2 + 8 }; }
    case "fact": case "candidate": { const width = textWidth(label, 12) + 36; return { width, height: 26, collide: width / 2 + 6 }; }
    default: return { width: 24, height: 24, collide: 26 };
  }
}

export function createMemoryGraph(root: HTMLElement, options: { onSelect(node: MemoryGraphNode): void; label: string }) {
  const doc = root.ownerDocument;
  const svg = doc.createElementNS(SVG, "svg");
  svg.classList.add("memory-graph");
  svg.setAttribute("role", "group");
  svg.setAttribute("aria-label", options.label);
  // The centre node's fill: a soft accent sphere.
  const defs = doc.createElementNS(SVG, "defs"), gradient = doc.createElementNS(SVG, "radialGradient");
  gradient.id = "memory-graph-self"; gradient.setAttribute("cx", "35%"); gradient.setAttribute("cy", "30%"); gradient.setAttribute("r", "75%");
  for (const [offset, alpha] of [["0%", ".55"], ["100%", "1"]] as const) {
    const stop = doc.createElementNS(SVG, "stop");
    stop.setAttribute("offset", offset); stop.setAttribute("style", `stop-color: rgb(var(--rb-accent-rgb)); stop-opacity: ${alpha}`);
    gradient.append(stop);
  }
  defs.append(gradient);
  const viewport = doc.createElementNS(SVG, "g"), edges = doc.createElementNS(SVG, "g"), vertices = doc.createElementNS(SVG, "g");
  viewport.append(edges, vertices); svg.append(defs, viewport); root.replaceChildren(svg);

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

  function shape(node: SimNode, label: string): SVGElement[] {
    const { width, height } = node.shape;
    if (node.kind === "self") {
      const halo = doc.createElementNS(SVG, "circle"); halo.classList.add("memory-graph__halo"); halo.setAttribute("r", "34");
      const body = doc.createElementNS(SVG, "circle"); body.classList.add("memory-graph__body"); body.setAttribute("r", "24");
      const text = doc.createElementNS(SVG, "text"); text.textContent = label; text.setAttribute("dy", "0.35em");
      return [halo, body, text];
    }
    if (node.kind === "category" || node.kind === "fact" || node.kind === "candidate") {
      const pill = doc.createElementNS(SVG, "rect"); pill.classList.add("memory-graph__body");
      pill.setAttribute("x", String(-width / 2)); pill.setAttribute("y", String(-height / 2));
      pill.setAttribute("width", String(width)); pill.setAttribute("height", String(height)); pill.setAttribute("rx", String(height / 2));
      const text = doc.createElementNS(SVG, "text"); text.textContent = label; text.setAttribute("dy", "0.35em");
      if (node.kind === "category") return [pill, text];
      // A coloured dot leads a memory's text: filled when confirmed, a ring while it waits for confirmation.
      const dot = doc.createElementNS(SVG, "circle"); dot.classList.add("memory-graph__dot"); dot.setAttribute("r", "3.5");
      dot.setAttribute("cx", String(-width / 2 + 13));
      text.setAttribute("x", String(7));
      return [pill, dot, text];
    }
    const disc = doc.createElementNS(SVG, "circle"); disc.classList.add("memory-graph__body"); disc.setAttribute("r", "12");
    const icon = doc.createElementNS(SVG, "path"); icon.classList.add("memory-graph__icon"); icon.setAttribute("d", ICON[node.kind === "project" ? "project" : "source"]);
    const text = doc.createElementNS(SVG, "text"); text.textContent = label; text.setAttribute("dy", "28");
    return [disc, icon, text];
  }

  function update(model: MemoryGraphModel) {
    simulation?.stop();
    const width = root.clientWidth || 640, height = Math.max(340, Math.min(540, width * 0.66));
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    view = { x: 0, y: 0, k: 1 }; place();
    const labels = new Map(model.nodes.map((node) => [node.id, node.kind === "fact" || node.kind === "candidate" ? shorten(node.label, 14)
      : node.kind === "source" || node.kind === "project" ? shorten(node.label, 12) : node.label]));
    const nodes: SimNode[] = model.nodes.map((node) => ({ ...node, shape: shapeOf(node, labels.get(node.id)!) }));
    const links: SimLink[] = model.links.map((link) => ({ ...link }));
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const neighbours = new Map<string, Set<string>>(nodes.map((node) => [node.id, new Set([node.id])]));
    for (const link of model.links) { neighbours.get(link.source)?.add(link.target); neighbours.get(link.target)?.add(link.source); }

    const paths = links.map((link) => {
      const path = doc.createElementNS(SVG, "path");
      path.classList.add("memory-graph__edge", `is-${link.kind}`);
      const tint = byId.get(link.target as string)?.category;
      if (tint) path.style.setProperty("--node-rgb", CATEGORY_RGB[tint] ?? CATEGORY_RGB.other);
      return path;
    });
    edges.replaceChildren(...paths);
    const groups = nodes.map((node) => {
      const group = doc.createElementNS(SVG, "g");
      group.classList.add("memory-graph__node", `is-${node.kind}`);
      group.dataset.nodeId = node.id;
      if (node.category) group.style.setProperty("--node-rgb", CATEGORY_RGB[node.category] ?? CATEGORY_RGB.other);
      const title = doc.createElementNS(SVG, "title"); title.textContent = node.label;
      group.append(...shape(node, labels.get(node.id)!), title);
      group.addEventListener("pointerenter", () => focus(node.id));
      group.addEventListener("pointerleave", () => focus(null));
      if (node.itemId || node.kind === "source" || node.kind === "project") {
        group.setAttribute("tabindex", "0"); group.setAttribute("role", "button"); group.setAttribute("aria-label", node.label);
        const open = () => { selected = node.id; mark(); options.onSelect(node); };
        group.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } });
        group.addEventListener("focus", () => focus(node.id));
        group.addEventListener("blur", () => focus(null));
        drag(group, node, open);
      } else drag(group, node);
      return group;
    });
    vertices.replaceChildren(...groups);

    /** Hovering a node keeps its chain lit and fades the rest. */
    function focus(id: string | null) {
      svg.classList.toggle("is-focusing", id !== null);
      const near = id ? neighbours.get(id)! : new Set<string>();
      groups.forEach((group, i) => group.classList.toggle("is-near", near.has(nodes[i].id)));
      paths.forEach((path, i) => {
        const a = (links[i].source as SimNode).id, b = (links[i].target as SimNode).id;
        path.classList.toggle("is-near", id !== null && (a === id || b === id));
      });
    }
    const draw = () => {
      links.forEach((link, i) => {
        const a = link.source as SimNode, b = link.target as SimNode, ax = a.x ?? 0, ay = a.y ?? 0, bx = b.x ?? 0, by = b.y ?? 0;
        // A gentle arc: the control point sits off the midpoint, a tenth of the length to one side.
        const cx = (ax + bx) / 2 - (by - ay) * 0.1, cy = (ay + by) / 2 + (bx - ax) * 0.1;
        paths[i].setAttribute("d", `M${ax},${ay} Q${cx},${cy} ${bx},${by}`);
      });
      nodes.forEach((node, i) => groups[i].setAttribute("transform", `translate(${node.x},${node.y})`));
    };
    simulation = forceSimulation(nodes)
      .force("link", forceLink<SimNode, SimLink>(links).id((node) => node.id).distance((link) => DISTANCE[link.kind]).strength(0.6))
      .force("charge", forceManyBody<SimNode>().strength((node) => node.kind === "self" ? -520 : node.kind === "category" ? -260 : -140))
      .force("center", forceCenter(width / 2, height / 2))
      .force("collide", forceCollide<SimNode>((node) => node.shape.collide))
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
          node.fx = (node.fx ?? node.x ?? 0) + dx; node.fy = (node.fy ?? node.y ?? 0) + dy; start.x = next.clientX; start.y = next.clientY;
          if (motionReduced(doc)) { node.x = node.fx; node.y = node.fy; draw(); }
        };
        const end = () => {
          group.classList.remove("is-dragging");
          group.removeEventListener("pointermove", move); group.removeEventListener("pointerup", end); group.removeEventListener("pointercancel", end);
          simulation?.alphaTarget(0); node.fx = null; node.fy = null;
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
