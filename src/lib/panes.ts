// Window panes: the main area as a tree of splits whose leaves are panes, each showing one tab. Every tab stays mounted (App.svelte
// positions it over its pane), so moving a tab between panes never reloads it. Pure functions: each returns a new tree.
export type Leaf = { type: "leaf"; id: string; tab: string };
export type Split = { type: "split"; id: string; dir: "row" | "col"; sizes: number[]; kids: Node[] };
export type Node = Leaf | Split;
/** Where a tab dropped on a pane goes: into it (center) or into a new pane on that side. */
export type Zone = "center" | "left" | "right" | "top" | "bottom";
export type Rect = { x: number; y: number; w: number; h: number };   // fractions of the main area

let seq = 0;
export const leaf = (tab: string): Leaf => ({ type: "leaf", id: `p${++seq}`, tab });

export function leaves(n: Node): Leaf[] { return n.type === "leaf" ? [n] : n.kids.flatMap(leaves); }
export const paneOf = (n: Node, tab: string) => leaves(n).find((l) => l.tab === tab) ?? null;
export const findLeaf = (n: Node, id: string) => leaves(n).find((l) => l.id === id) ?? null;

function map(n: Node, f: (l: Leaf) => Node): Node {
  return n.type === "leaf" ? f(n) : { ...n, kids: n.kids.map((k) => map(k, f)) };
}
/** `tab` shown in the pane `pane`. */
export const setTab = (n: Node, pane: string, tab: string): Node => map(n, (l) => (l.id === pane ? { ...l, tab } : l));

/** A new pane showing `tab` beside the pane `pane`, on the side `zone`. Returns the tree and the new pane. */
export function splitAt(n: Node, pane: string, zone: Exclude<Zone, "center">, tab: string): { tree: Node; added: Leaf } {
  const added = leaf(tab);
  return { tree: insertAt(n, pane, zone, added), added };
}
/** The tree `node` (a pane, or a whole group of panes) beside the pane `pane`, on the side `zone`. */
export function insertAt(n: Node, pane: string, zone: Exclude<Zone, "center">, node: Node): Node {
  const added = node, dir = zone === "left" || zone === "right" ? "row" : "col", before = zone === "left" || zone === "top";
  const go = (node: Node): Node => {
    if (node.type === "leaf") {
      if (node.id !== pane) return node;
      return { type: "split", id: `s${++seq}`, dir, sizes: [0.5, 0.5], kids: before ? [added, node] : [node, added] };
    }
    // Into a split of the same direction: a sibling there (the pane's share halves), not a split inside a split.
    const i = node.kids.findIndex((k) => k.type === "leaf" && k.id === pane);
    if (i >= 0 && node.dir === dir && added.type === "leaf") {
      const sizes = [...node.sizes], half = sizes[i]! / 2, kids = [...node.kids], at = before ? i : i + 1;
      sizes[i] = half; sizes.splice(at, 0, half); kids.splice(at, 0, added);
      return { ...node, sizes, kids };
    }
    return { ...node, kids: node.kids.map(go) };
  };
  return go(n);
}

/** The tree without the pane `pane` (its space goes to its neighbours); null if it was the only pane. */
export function removePane(n: Node, pane: string): Node | null {
  if (n.type === "leaf") return n.id === pane ? null : n;
  const kids: Node[] = [], sizes: number[] = [];
  let freed = 0;
  n.kids.forEach((k, i) => { const r = removePane(k, pane); if (r) { kids.push(r); sizes.push(n.sizes[i]!); } else freed += n.sizes[i]!; });
  if (!kids.length) return null;
  if (kids.length === 1) return kids[0]!;
  const total = sizes.reduce((a, b) => a + b, 0);
  return { ...n, kids, sizes: sizes.map((s) => s + freed * (s / total)) };
}

/** Moves `tab` onto the pane `target`: into it (center: the two panes swap their tabs if `tab` was shown elsewhere) or into a
 *  new pane at its side (the pane it came from closes). Returns the tree and the pane that now shows `tab`. */
export function moveTab(n: Node, tab: string, target: string, zone: Zone, fallback: () => string | null): { tree: Node; pane: string } {
  const from = paneOf(n, tab), to = findLeaf(n, target);
  if (!to) return { tree: n, pane: from?.id ?? target };
  if (zone === "center") {
    if (from && from.id !== to.id) return { tree: setTab(setTab(n, from.id, to.tab), to.id, tab), pane: to.id };
    return { tree: setTab(n, to.id, tab), pane: to.id };
  }
  if (from && from.id === to.id) {
    // Its own pane, to a side: the tab moves out and the pane keeps another tab (none: nothing to do).
    const other = fallback();
    if (!other) return { tree: n, pane: from.id };
    const r = splitAt(setTab(n, from.id, other), from.id, zone, tab);
    return { tree: r.tree, pane: r.added.id };
  }
  let tree: Node = n;
  if (from) tree = removePane(tree, from.id) ?? tree;
  const r = splitAt(tree, to.id, zone, tab);
  return { tree: r.tree, pane: r.added.id };
}

export type Divider = { split: string; index: number; dir: "row" | "col"; rect: Rect; parent: Rect };
/** Each pane's rectangle, and the dividers between neighbours (their split, the index of the boundary, the split's rectangle). */
export function layout(n: Node, r: Rect = { x: 0, y: 0, w: 1, h: 1 }): { panes: Map<string, Rect & { tab: string }>; dividers: Divider[] } {
  const panes = new Map<string, Rect & { tab: string }>(), dividers: Divider[] = [];
  const go = (node: Node, rect: Rect) => {
    if (node.type === "leaf") { panes.set(node.id, { ...rect, tab: node.tab }); return; }
    let at = 0;
    node.kids.forEach((k, i) => {
      const s = node.sizes[i]!;
      const kr = node.dir === "row" ? { x: rect.x + at * rect.w, y: rect.y, w: s * rect.w, h: rect.h } : { x: rect.x, y: rect.y + at * rect.h, w: rect.w, h: s * rect.h };
      go(k, kr);
      at += s;
      if (i < node.kids.length - 1)
        dividers.push({ split: node.id, index: i, dir: node.dir, parent: rect,
          rect: node.dir === "row" ? { x: rect.x + at * rect.w, y: rect.y, w: 0, h: rect.h } : { x: rect.x, y: rect.y + at * rect.h, w: rect.w, h: 0 } });
    });
  };
  go(n, r);
  return { panes, dividers };
}

/** The split `split`'s boundary `index` moved to `frac` (0..1 across the split): the two panes beside it share the change. */
export function resize(n: Node, split: string, index: number, frac: number, min = 0.06): Node {
  if (n.type === "leaf") return n;
  if (n.id !== split) return { ...n, kids: n.kids.map((k) => resize(k, split, index, frac, min)) };
  const sizes = [...n.sizes], start = sizes.slice(0, index).reduce((a, b) => a + b, 0), pair = sizes[index]! + sizes[index + 1]!;
  const a = Math.min(Math.max(frac - start, min), pair - min);
  sizes[index] = a; sizes[index + 1] = pair - a;
  return { ...n, sizes };
}
