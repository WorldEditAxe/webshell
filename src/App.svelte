<!-- Nanite Webshell: a Linux root filesystem (Ubuntu 26.04 LTS by default; lib/roots.ts) on Nanite, in xterm.js. A top bar
     with the tabs (the main terminal stays; more terminals, VS Code and the monitor open from + and close), and a menu with the
     disk's save / load / reset and the settings (lib/SettingsDialog.svelte). -->
<script lang="ts">
  import { onMount, tick } from "svelte";
  import { fly, scale } from "svelte/transition";
  import { flip } from "svelte/animate";
  import { motion } from "./lib/motion";
  import {
    Terminal as TerminalIcon, Monitor, Plus, X, Menu, Save, FolderOpen, RotateCcw, Code, Globe, Settings as SettingsIcon, Bell, Columns2, Rows2, MonitorUp,
    PanelTopClose, PanelTopOpen, WifiOff, RefreshCw, ExternalLink, GitBranch, MemoryStick, Maximize2, LoaderCircle,
  } from "@lucide/svelte";
  import TerminalView from "./lib/TerminalView.svelte";
  import MonitorView from "./lib/MonitorView.svelte";
  import SettingsDialog from "./lib/SettingsDialog.svelte";
  import PreviewView from "./lib/PreviewView.svelte";
  import { servePreviews, proxiedUrl, unproxiedUrl, devtoolsForFrames } from "./lib/preview";
  import * as P from "./lib/panes";
  import AskDialog from "./lib/AskDialog.svelte";
  import CodeView from "./lib/CodeView.svelte";
  import { Bars, C, Shell, snap } from "./lib/term";
  import * as settings from "./lib/settings";
  import * as M from "./lib/machine";
  import * as roots from "./lib/roots";
  import { theme, applyTheme } from "./lib/themes";
  import { ffsTar, forgetFfsCache } from "./lib/ffsroot";
  import { ask } from "./lib/ask.svelte";
  import { FSD, GuestFiles } from "./lib/files";
  import { Tunnels } from "./lib/tunnels.svelte";
  import { Playit } from "./lib/playit.svelte";

  type Tab = { id: string; kind: "term" | "monitor" | "code" | "preview"; shell?: Shell; termId?: number; closable: boolean };
  const w = window as unknown as Record<string, unknown>;
  const enc = new TextEncoder();
  // Boot timings (ms since navigation), for finding what is slow: window.bootTimes.
  const bootTimes: Record<string, number> = (w.bootTimes = {});
  const mark = (name: string) => { bootTimes[name] = Math.round(performance.now()); };

  const initial = settings.effective();
  applyTheme(theme(initial.theme));
  let launch = $state(initial);
  const root = roots.current();
  const main = new Shell(settings.terminalOptions(initial));
  w.term = main.term;

  let tabs = $state.raw<Tab[]>([
    { id: "main", kind: "term", shell: main, closable: false },
  ]);   // the Display opens from + (or from the hint when something is drawn on the screen)
  // Tabs and panes (lib/panes.ts): each tab in the bar is a group of panes (its own tree of splits); each pane shows one view
  // (`tabs` below: a terminal, VS Code, a Web Browser, the Display). `active` is the focused pane's view in the open tab.
  type Win = { id: string; tree: P.Node; focus: string };
  let winSeq = 0;
  const newWin = (view: string): Win => { const l = P.leaf(view); return { id: `w${++winSeq}`, tree: l, focus: l.id }; };
  const firstWin = newWin("main");
  let wins = $state.raw<Win[]>([firstWin]);
  let curWin = $state(firstWin.id);
  const win = $derived(wins.find((x) => x.id === curWin) ?? wins[0]!);
  const tree = $derived(win.tree), focus = $derived(win.focus);
  const lay = $derived(P.layout(tree));
  const multi = $derived(lay.panes.size > 1);
  const shown = $derived(new Set([...lay.panes.values()].map((p) => p.tab)));
  const active = $derived(P.findLeaf(tree, focus)?.tab ?? P.leaves(tree)[0]!.tab);
  let titles = $state<Record<string, string>>({ main: root.name, monitor: "Display" });
  let belled = $state<Record<string, boolean>>({});
  let nv = $state.raw<M.Nanite | null>(null);
  let booted = $state(false);
  let sh = $state.raw<M.Shells>(M.shells("bash"));
  let hasPerl = $state(true);
  let plusX = $state(0);
  let menuOpen = $state(false), plusOpen = $state(false), settingsOpen = $state(false);
  let settingsTab = $state<"nanite" | "network" | "terminal" | "storage">("nanite");
  let monitor = $state<MonitorView>();
  let screen = $state({ width: 0, height: 0 });
  let diskHold: { held: boolean; release: () => void } | null = null;
  let drawHint = $state(false);
  // The top bar can hide (the open tab gets the whole window); it shows again while the pointer is at the top edge.
  const BAR_KEY = "nanite-webshell:bar-hidden";
  let barHidden = $state((() => { try { return localStorage.getItem(BAR_KEY) === "1"; } catch { return false; } })());
  let barPeek = $state(false);
  let online = $state(navigator.onLine);
  let wispDown = $state(false);   // the Wisp connection dropped and is reconnecting (lib/machine.ts)
  // The pointer has to rest on the top edge a moment before the bar slides in, so passing over it does nothing.
  let peekTimer = 0;
  function peekSoon(): void { clearTimeout(peekTimer); peekTimer = window.setTimeout(() => (barPeek = true), 350); }
  function peekCancel(): void { clearTimeout(peekTimer); }
  function toggleBar(): void {
    barHidden = !barHidden; barPeek = false; menuOpen = false;
    try { localStorage.setItem(BAR_KEY, barHidden ? "1" : "0"); } catch {}
  }
  // Memory events (Nanite's "memoryevent"): memory ran out; the notice says what the OOM killer ended and asks for more memory.
  let memNotice = $state<{ detail: string; n: number } | null>(null), memTimer = 0;
  const MiBs = (b: number) => `${Math.round(b / 2 ** 20)} MiB`;
  function onMemoryEvent(e: M.MemoryEvent): void {
    console.warn("nanite memoryevent", e);
    const who = (p: { pid: number; name?: string }) => `${p.name ?? "process"} (pid ${p.pid})`;
    const detail = e.killed.length ? `Killed ${e.killed.map((k) => `${who(k)}, ${MiBs(k.resident)}`).join("; ")}.`
      : e.result === "over" ? `In use: ${MiBs(e.inUse)} of ${MiBs(e.limit ?? 0)}.`
      : e.kind === "process" ? `${who(e)} reached the per-process cap (${MiBs(e.limit ?? 0)}).`
      : `${e.pid ? who(e) : "A process"} was refused ${MiBs(e.requested)}.`;
    memNotice = { detail, n: (memNotice?.n ?? 0) + 1 };
    clearTimeout(memTimer); memTimer = window.setTimeout(() => (memNotice = null), 20000);
  }
  // VS Code mode: the page is one VS Code on the machine, full window (the ☰ menu turns it on; VS Code's dialog or its
  // command "Nanite: Disable VS Code Mode" turns it off). Remembered across visits.
  const CODE_MODE_KEY = "nanite-webshell:vscode-mode";
  let codeMode = $state((() => { try { return localStorage.getItem(CODE_MODE_KEY) === "1"; } catch { return false; } })());
  let bootError = $state("");
  function setCodeMode(on: boolean): void {
    codeMode = on; menuOpen = false;
    try { localStorage.setItem(CODE_MODE_KEY, on ? "1" : "0"); } catch {}
  }
  $effect(() => { if (codeMode && booted && !hasPerl) setCodeMode(false); });   // no file server on this root: no VS Code
  // Tunnels (Settings > Network): the machine's ports on the internet, with this page as their client; they start with the machine.
  let relay = $state<{ url: string; name: string } | null>(null);
  const tunnels = new Tunnels(() => nv, () => relay?.url ?? null);
  w.tunnels = tunnels;
  const playit = new Playit(() => tunnels.wisp(), () => relay?.url ?? null, () => tunnels.net, () => (nv ? (p?: number) => nv!.network.bindUDP(p ?? 0) : null));
  w.playit = playit;
  let fileInput: HTMLInputElement;
  let busy = false, counter = 1, stopPing = () => {};
  // Nanite's terminals (openTerminal) by id: where their output goes and what to do when they end. Output that arrives before
  // openTerminal has answered waits in `pending`.
  const terms = new Map<number, { sink: (b: Uint8Array) => void; onExit?: () => void }>();
  const pending = new Map<number, Uint8Array[]>(), gone = new Set<number>();
  const monitorOpen = $derived(tabs.some((t) => t.id === "monitor"));

  /** Flags a tab whose terminal rang its bell while another tab was shown. */
  const flagBell = (id: string) => () => { if (!shown.has(id) || document.hidden) belled[id] = true; };
  $effect(() => { for (const id of shown) if (belled[id]) belled[id] = false; });

  main.term.onTitleChange((t) => (titles.main = t || root.name));
  main.onBell = flagBell("main");
  main.onInput = (d) => { if (nv && mainId !== null) nv.stdin(enc.encode(d), mainId); else if (nv && booted && !starting && d.includes("\r")) void shell(); };
  main.onResize = (cols, rows) => { if (mainId !== null) nv?.resize(cols, rows, mainId); };
  const say = (m: string) => main.term.write(`\r\n${C.lilac}[${m}]${C.off}\r\n`);

  // The main tab's login shell: a terminal (pty) of the machine like the others, not Nanite's console, which is no full pty
  // (fish exits on it at its first external command). With the motd. When it ends, Enter starts another.
  let mainId: number | null = null, starting = false;
  async function shell(): Promise<void> {
    if (!nv) return;
    starting = true; main.refit();
    if (!bootTimes.shellStart) mark("shellStart");
    main.term.write("\x1b[?25h");
    const dec = new TextDecoder();
    try {
      mainId = await openPty(sh.term(), sh.termEnv().filter((v) => v !== "MOTD_SHOWN=1"), { cols: main.term.cols, rows: main.term.rows }, (b) => {
        if (!bootTimes.firstOutput) mark("firstOutput");
        main.term.write(b);
        if (!bootTimes.prompt && /[#$>] $/.test(dec.decode(b, { stream: true }))) mark("prompt");
      }, () => {
        mainId = null;
        main.term.write(`\r\n${C.dim}[the shell exited; press Enter for a new one]${C.off}\r\n`);
      });
    } catch (e) {
      main.term.write(`\r\n${C.red}could not start the shell:${C.off} ${(e as Error).message}\r\n`);
    } finally { starting = false; }
  }

  /** Opens a terminal in the machine (a pty, `argv` its session leader) whose output goes to `sink`; resolves with its id. */
  async function openPty(argv: string[], env: string[], size: { cols: number; rows: number }, sink: (b: Uint8Array) => void, onExit?: () => void): Promise<number> {
    if (!nv) throw new Error("the machine is not running");
    const termId = await Promise.race([
      nv.openTerminal(argv, env, size),
      M.sleep(15000).then(() => { throw new Error("the machine did not answer"); }),
    ]);
    terms.set(termId, { sink, onExit });
    for (const b of pending.get(termId) ?? []) sink(b);
    pending.delete(termId);
    return termId;
  }
  function closePty(termId: number): void { gone.add(termId); terms.delete(termId); nv?.closeTerminal(termId); }

  // More terminals: each a pty of its own in the same machine (Nanite's openTerminal), with a login shell.
  async function newTab(split?: Exclude<P.Zone, "center">): Promise<void> {
    plusOpen = false;
    if (!nv || !booted) return;
    const cur = nv, n = ++counter, id = `t${n}`, s = new Shell(settings.terminalOptions(launch));
    tabs = [...tabs, { id, kind: "term", shell: s, closable: true }];
    titles[id] = `shell ${n}`; place(id, split);
    s.term.onTitleChange((t) => (titles[id] = t || `shell ${n}`));
    s.onBell = flagBell(id);
    await tick();   // mounted and fitted, so the pty starts at the right size
    try {
      const termId = await openPty(sh.term(), sh.termEnv(), { cols: s.term.cols, rows: s.term.rows }, (b) => s.term.write(b), () => closeTab(id, false));
      if (!tabs.some((t) => t.id === id)) { closePty(termId); return; }   // closed while it was starting
      tabs = tabs.map((t) => (t.id === id ? { ...t, termId } : t));
      s.onInput = (d) => cur.stdin(enc.encode(d), termId);
      s.onResize = (cols, rows) => cur.resize(cols, rows, termId);
      s.refit();
    } catch (e) {
      s.term.write(`${C.red}could not open a terminal:${C.off} ${(e as Error).message}\r\n`);
    }
  }
  // VS Code tabs (lib/CodeView.svelte): each its own VS Code for the Web, all on the machine through one guest file server
  // (Perl), which runs while any of them is open.
  let codeCount = 0, fsdUsers = 0, fsdId: number | null = null, fsdStart: Promise<void> | null = null;
  const fileServer = {
    acquire(): Promise<void> {
      fsdUsers++;
      return (fsdStart ??= (async () => {
        let out = "";
        const dec = new TextDecoder();
        // perl -e as the session leader, which never execs.
        fsdId = await openPty(["/usr/bin/perl", "-e", FSD], sh.env, { cols: 200, rows: 24 }, (b) => { out += dec.decode(b); },
          () => { fsdId = null; fsdStart = null; });
        await new GuestFiles(nv!).ready().catch((e) => { fsdStart = null; throw new Error(`the file server did not start: ${out.trim() || (e as Error).message}`); });
      })());
    },
    release(): void {
      if (--fsdUsers > 0) return;
      if (fsdId !== null) closePty(fsdId);
      fsdId = null; fsdStart = null;
    },
  };
  function openCode(): void {
    plusOpen = false;
    if (!nv || !booted || !hasPerl) return;
    const n = ++codeCount, id = `code${n}`;
    tabs = [...tabs, { id, kind: "code", closable: true }];
    titles[id] = n === 1 ? "VS Code" : `VS Code ${n}`; show(id);
  }
  // Preview tabs (lib/PreviewView.svelte, on Scramjet): the machine's web servers and the web, through this machine and its Wisp relay.
  let previewCount = 0;
  servePreviews(() => nv ?? null, () => (w.wisp as { url?: string } | undefined)?.url ?? null);
  // For VS Code (its page is this origin, in a frame of this page): the proxied address of a URL (lib/preview.ts).
  w.naniteProxiedUrl = proxiedUrl;
  w.naniteUnproxiedUrl = unproxiedUrl;
  w.naniteDevtools = devtoolsForFrames;
  function openPreview(): void {
    plusOpen = false;
    const n = ++previewCount, id = `preview${n}`;
    tabs = [...tabs, { id, kind: "preview", closable: true }];
    titles[id] = "Web Browser"; show(id);
  }
  function openMonitor(): void {
    plusOpen = false; drawHint = false;
    if (!monitorOpen) tabs = [...tabs.slice(0, 1), { id: "monitor", kind: "monitor", closable: true }, ...tabs.slice(1)];
    show("monitor");
  }
  // The first picture on the screen while the monitor tab is closed: say so.
  function onDraw(): void { if (!monitorOpen) drawHint = true; }

  /** Closes a tab; `hangup`: its shell is still running, so hang its terminal up (SIGHUP). */
  function closeTab(id: string, hangup = true): void {
    const i = tabs.findIndex((t) => t.id === id), tab = tabs[i];
    if (!tab?.closable) return;
    if (tab.termId !== undefined) { if (hangup) closePty(tab.termId); else { gone.add(tab.termId); terms.delete(tab.termId); } }
    tabs = tabs.filter((t) => t.id !== id);
    delete titles[id]; delete belled[id];
    if (id === "monitor") titles.monitor = "Display";
    unplace(id);
  }
  const setWin = (id: string, patch: Partial<Win>) => { wins = wins.map((x) => (x.id === id ? { ...x, ...patch } : x)); };
  const winOf = (view: string) => wins.find((x) => P.paneOf(x.tree, view)) ?? null;
  const setFocus = (pane: string) => setWin(win.id, { focus: pane });
  const setTree = (t: P.Node, f?: string) => setWin(win.id, { tree: t, ...(f ? { focus: f } : {}) });
  /** Shows the view `id`: opens its tab and focuses its pane; a view in no tab gets a tab of its own. */
  function show(id: string): void {
    const w = winOf(id);
    if (w) { curWin = w.id; setWin(w.id, { focus: P.paneOf(w.tree, id)!.id }); return; }
    const n = newWin(id); wins = [...wins, n]; curWin = n.id;
  }
  /** A new view: in a tab of its own, or (`split`) in a new pane beside the focused one in this tab. */
  function place(id: string, split?: Exclude<P.Zone, "center">): void {
    if (!split) { show(id); return; }
    const r = P.splitAt(tree, focus, split, id);
    setTree(r.tree, r.added.id);
  }
  /** Takes the view `id` out of its tab (its pane closes; the tab too, if that was its last pane). */
  function unplace(id: string): void {
    const w = winOf(id);
    if (!w) return;
    const r = P.removePane(w.tree, P.paneOf(w.tree, id)!.id);
    if (r) { setWin(w.id, { tree: r, focus: P.findLeaf(r, w.focus) ? w.focus : P.leaves(r)[0]!.id }); return; }
    const i = wins.findIndex((x) => x.id === w.id);
    wins = wins.filter((x) => x.id !== w.id);
    if (curWin === w.id && wins.length) curWin = wins[Math.min(i, wins.length - 1)]!.id;
  }
  /** Splits the pane `pane` (the focused one by default) with a new terminal beside it. */
  function splitPane(zone: "right" | "bottom", pane = focus): void { setFocus(pane); void newTab(zone); }
  const viewsOf = (w: Win) => P.leaves(w.tree).map((l) => l.tab);
  const winClosable = (w: Win) => viewsOf(w).every((v) => tabs.find((t) => t.id === v)?.closable);
  /** Closes a tab: every view in it. */
  function closeWin(w: Win): void { if (winClosable(w)) for (const v of viewsOf(w)) closeTab(v); }
  // Dragging a pane (by its header): onto a pane of this tab (into it: the two swap; or beside it), onto another tab in the bar
  // (it joins that tab, beside its focused pane), or onto the bar's empty space (a tab of its own).
  let dragTab = $state<string | null>(null), drop = $state<{ pane: string; zone: P.Zone } | null>(null), dropWin = $state<string | null>(null);
  function zoneAt(e: DragEvent, el: HTMLElement): P.Zone {
    const r = el.getBoundingClientRect(), x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    const d = { left: x, right: 1 - x, top: y, bottom: 1 - y }, [side, dist] = Object.entries(d).sort((a, b) => a[1] - b[1])[0]!;
    return dist < 0.25 ? (side as P.Zone) : "center";
  }
  function dragStart(e: DragEvent, id: string): void {
    dragTab = id; e.dataTransfer?.setData("text/x-nanite-pane", id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }
  const dragEnd = () => { dragTab = null; dragWin = null; drop = null; dropWin = null; reorder = null; };
  // A tab dragged along the bar: dropped before or after another tab, it moves there.
  let reorder = $state<{ id: string; after: boolean } | null>(null);
  function reorderOver(e: DragEvent, id: string): void {
    if (!dragWin || dragWin === id) { reorder = null; return; }
    e.preventDefault(); e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
    if (reorder?.id !== id || reorder.after !== after) { snap(0.35); reorder = { id, after }; }
  }
  function reorderDrop(e: DragEvent): void {
    e.preventDefault(); e.stopPropagation();
    const src = wins.find((x) => x.id === dragWin), at = reorder;
    dragEnd();
    if (!src || !at || src.id === at.id) return;
    const rest = wins.filter((x) => x.id !== src.id), i = rest.findIndex((x) => x.id === at.id);
    if (i < 0) return;
    rest.splice(at.after ? i + 1 : i, 0, src); wins = rest; snap();
  }
  // A whole tab dragged from the bar onto a pane of the open tab: its panes join this tab there (into a pane: they go beside it).
  let dragWin = $state<string | null>(null);
  function dragWinStart(e: DragEvent, id: string): void {
    dragWin = id; e.dataTransfer?.setData("text/x-nanite-tab", id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }
  function dropTab(): void {
    if ((dragWin || dragTab) && drop) snap();
    if (dragWin && drop) {
      const src = wins.find((x) => x.id === dragWin);
      if (src && src.id !== win.id) {
        const zone = drop.zone === "center" ? "right" : drop.zone;
        const t = P.insertAt(tree, drop.pane, zone, src.tree), target = win.id;
        wins = wins.filter((x) => x.id !== src.id);
        setWin(target, { tree: t, focus: src.focus });
      }
    } else if (dragTab && drop && winOf(dragTab)?.id === win.id) {
      const r = P.moveTab(tree, dragTab, drop.pane, drop.zone, () => null);
      setTree(r.tree, r.pane);
    }
    dragEnd();
  }
  /** The dragged pane into the tab `target` (null: a new tab). */
  function dropIntoWin(target: string | null): void {
    const v = dragTab;
    dragEnd();
    if (!v) return;
    const from = winOf(v);
    if (!from || from.id === target || (!target && P.leaves(from.tree).length < 2)) return;
    snap();
    unplace(v);
    if (!target) { const n = newWin(v); wins = [...wins, n]; curWin = n.id; return; }
    const t = wins.find((x) => x.id === target);
    if (!t) return;
    const r = P.splitAt(t.tree, t.focus, "right", v);
    setWin(t.id, { tree: r.tree, focus: r.added.id }); curWin = t.id;
  }
  const zoneRect: Record<P.Zone, string> = { center: "inset-2", left: "inset-y-2 left-2 w-1/2", right: "inset-y-2 right-2 w-1/2", top: "inset-x-2 top-2 h-1/2", bottom: "inset-x-2 bottom-2 h-1/2" };
  // Dividers: dragged to resize the panes beside them (an overlay over the frames meanwhile, so iframes do not take the pointer).
  let mainEl = $state<HTMLElement>(), resizing = $state<P.Divider | null>(null);
  function startResize(e: PointerEvent, d: P.Divider): void {
    if (e.button !== 0) return;
    e.preventDefault(); resizing = d;
    // The divider keeps the pointer until the button is released (even outside the window, or over a frame), and a move with
    // no button down ends the drag too: a resize never goes on following the mouse after the release.
    const el = e.currentTarget as HTMLElement;
    try { el.setPointerCapture(e.pointerId); } catch {}
    const move = (m: PointerEvent) => {
      if (!(m.buttons & 1)) { up(); return; }
      const r = mainEl!.getBoundingClientRect(), size = d.dir === "row" ? r.width * d.parent.w : r.height * d.parent.h;
      const frac = d.dir === "row" ? ((m.clientX - r.left) / r.width - d.parent.x) / d.parent.w : ((m.clientY - r.top) / r.height - d.parent.y) / d.parent.h;
      setTree(P.resize(tree, d.split, d.index, frac, Math.min(0.45, Math.max(0.06, (HDR + 100) / size))));   // a pane keeps 100 px below its header
    };
    const up = () => {
      resizing = null;
      el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); el.removeEventListener("lostpointercapture", up);
    };
    el.addEventListener("pointermove", move); el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up); el.addEventListener("lostpointercapture", up);
  }
  const HDR = 26;   // a pane's header, when there are several
  /** A tab's box: over its pane (below its header), or the whole area when no pane shows it (it is hidden then). */
  function boxOf(id: string): string {
    for (const p of lay.panes.values()) if (p.tab === id) {
      const h = multi ? HDR : 0;
      return `left:${p.x * 100}%;top:calc(${p.y * 100}% + ${h}px);width:${p.w * 100}%;height:calc(${p.h * 100}% - ${h}px)`;
    }
    return "inset:0";
  }
  const pct = (r: P.Rect) => `left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%`;
  // The focused pane follows the pointer and the keyboard: a click in a pane, or focus moving into its frame.
  function paneAt(clientX: number, clientY: number): string | null {
    const r = mainEl?.getBoundingClientRect();
    if (!r) return null;
    const x = (clientX - r.left) / r.width, y = (clientY - r.top) / r.height;
    for (const [id, p] of lay.panes) if (x >= p.x && x < p.x + p.w && y >= p.y && y < p.y + p.h) return id;
    return null;
  }
  $effect(() => {
    const blur = () => setTimeout(() => {
      const el = document.activeElement?.closest?.("[data-tab]") as HTMLElement | null, p = el && P.paneOf(tree, el.dataset.tab!);
      if (p && p.id !== focus) setFocus(p.id);
    });
    addEventListener("blur", blur);
    return () => removeEventListener("blur", blur);
  });
  // The focused tab's terminal takes the keyboard.
  $effect(() => { const t = tabs.find((x) => x.id === active); if (t?.shell) requestAnimationFrame(() => t.shell!.term.focus()); });

  function onTerminalExit(termId: number): void {
    const t = terms.get(termId);
    terms.delete(termId); gone.add(termId);
    t?.onExit?.();
  }
  function onOutput(_fd: number, bytes: Uint8Array, termId?: number): void {
    if (termId === undefined) {
      if (!bootTimes.firstOutput) mark("firstOutput");
      main.term.write(bytes);
      if (!bootTimes.prompt && /[#$] $/.test(new TextDecoder().decode(bytes))) mark("prompt");
      return;
    }
    const t = terms.get(termId);
    if (t) t.sink(bytes);
    else if (!gone.has(termId)) { const p = pending.get(termId) ?? []; p.push(bytes.slice()); pending.set(termId, p); }
  }

  async function stopMachine(): Promise<void> {
    mainId = null; booted = false; stopPing();
    if (!nv) return;
    const cur = nv;
    await Promise.race([cur.flush().catch(() => {}), M.sleep(5000)]);
    cur.terminate(); nv = null; w.nv = null;
    diskHold?.release(); diskHold = null;
  }
  async function act(name: string, f: () => Promise<void>): Promise<void> {
    if (busy) return; busy = true; menuOpen = false; show("main");
    try { await f(); } catch (e) { main.term.write(`\r\n${C.red}${name} failed:${C.off} ${(e as Error)?.message ?? e}\r\n`); console.error(e); busy = false; }
  }
  const restart = (why: string) => act("restart", async () => { say(why); await stopMachine(); location.reload(); });
  async function saveDisk(): Promise<void> {
    if (!(await ask({ title: "Save the disk?", message: `${root.name} to a .tar.gz. The machine restarts afterwards.`, tone: "warn", confirm: "Save" }))) return;
    void act("save", async () => {
      say("saving: stopping the machine");
      await stopMachine();
      const blob = await M.packDisk(root.disk, (done, total) => main.term.write(`\r\x1b[2K${C.dim}  ${M.mb(done)} / ${M.mb(total)} MB${C.off}`));
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = `nanite-${root.id}-${new Date().toISOString().slice(0, 10)}.tar.gz`; a.click();
      say(`saved ${a.download} (${M.mb(blob.size)} MB); restarting`);
      await M.sleep(1500); location.reload();
    });
  }
  async function pickedFile(): Promise<void> {
    const file = fileInput.files?.[0]; fileInput.value = "";
    if (!file || !(await ask({ title: `Load ${file.name}?`, message: `It replaces the whole disk of ${root.name}.`, tone: "danger", confirm: "Load" }))) return;
    void act("load", async () => {
      const write = await M.openSave(file, root.disk);
      say(`loading ${file.name}: stopping the machine`);
      await stopMachine();
      const r = await write((n, bytes) => main.term.write(`\r\x1b[2K${C.dim}  ${n} files, ${M.mb(bytes)} MB${C.off}`));
      say(`loaded ${r.files} files (${M.mb(r.bytes)} MB); restarting`);
      await M.sleep(800); location.reload();
    });
  }
  const resetNow = () => act("reset", async () => {
    say("resetting: stopping the machine");
    await stopMachine();
    try { await M.deleteDisk(root.disk); }
    catch (e) {
      if (await M.diskInUse(root.disk)) throw new Error(`${root.name} is open in another tab of the webshell: close that tab, then reset again`);
      // Still open in this page (the machine's files were not let go yet): delete it on the next start, before anything opens it.
      M.markReset(root.disk);
      say(`the disk is still in use (${(e as Error).name}); reloading to delete it`);
      await M.sleep(500); location.reload(); return;
    }
    say(`disk deleted; starting a fresh ${root.name}`);
    await M.sleep(500); location.reload();
  });
  async function resetDisk(): Promise<void> {
    if (await ask({ title: `Reset ${root.name}?`, message: "Everything changed on this root is deleted.", tone: "danger", confirm: "Reset" })) void resetNow();
  }
  function switchRoot(id: string): void {
    roots.select(id);
    void restart(`switching to ${roots.all().find((r) => r.id === id)?.name ?? id}`);
  }
  function applySettings(l: settings.Launch): void {
    const needs = settings.needsRestart(launch, l);
    settings.save(l);
    applyTheme(theme(l.theme));
    for (const t of tabs) t.shell?.configure(settings.terminalOptions(l));
    launch = l;
    if (needs) void restart("restarting with the new settings");
  }
  // Without Nanite's resizeScreen (or with the size fixed in the settings), matching a resized window takes a restart.
  function fitScreen(): void {
    const l = { ...launch, screenWidth: null, screenHeight: null };
    settings.save(l); launch = l;
    void restart("restarting with the screen at the window's size");
  }
  function openSettings(t: typeof settingsTab): void { menuOpen = false; settingsTab = t; settingsOpen = true; }

  onMount(() => {
    // Close the menus on a click outside them or Esc.
    const away = (e: Event) => {
      if (!(e.target as Element).closest?.("[data-menu]")) menuOpen = false;
      if (!(e.target as Element).closest?.("[data-plus]")) plusOpen = false;
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") { menuOpen = false; plusOpen = false; }
      // Ctrl+Shift+B: hide / show the top bar (caught before the terminals see it).
      if (e.ctrlKey && e.shiftKey && e.code === "KeyB") { e.preventDefault(); e.stopPropagation(); toggleBar(); }
    };
    const net = () => { online = navigator.onLine; };
    addEventListener("pointerdown", away); addEventListener("keydown", esc, true);
    addEventListener("online", net); addEventListener("offline", net);
    // Nanite writes back on pagehide itself; also when the tab is hidden.
    const hide = () => { if (document.visibilityState === "hidden") nv?.flush(); };
    addEventListener("visibilitychange", hide);
    void boot();
    return () => { removeEventListener("pointerdown", away); removeEventListener("keydown", esc, true); removeEventListener("visibilitychange", hide); removeEventListener("online", net); removeEventListener("offline", net); };
  });

  /** The root's image as a tar stream: a FragmentedFS store (built-in roots) or a .tar.gz (the first start of a root unpacks it onto its disk). */
  async function image(onBuild: (state: string) => void): Promise<{ body: ReadableStream<Uint8Array>; total: number; gz: boolean; scale?: number }> {
    const src = root.source;
    if (src.kind === "file") { const f = await roots.loadSource(root.id); return { body: f.stream(), total: f.size, gz: true }; }
    if (src.kind === "ffs") { const t = await ffsTar(src.url); return { body: t.body, total: t.total, gz: false, scale: t.download / t.total }; }
    const url = src.kind === "docker" ? await roots.dockerBuild(src.image, (s) => onBuild(s.state)) : src.url;
    const r = await fetch(url);
    if (!r.ok || !r.body) throw new Error(`${url}: HTTP ${r.status}`);
    const gz = !r.headers.get("content-encoding");
    return { body: r.body, total: gz ? +(r.headers.get("content-length") ?? 0) : 0, gz };
  }

  async function boot(): Promise<void> {
    const t = main.term;
    t.write("\x1b[?25l"); // no cursor while loading
    try {
      // ?reset: delete the disk and start from a fresh image (and drop ?reset from the URL, so a reload keeps the new disk).
      const q = new URLSearchParams(location.search);
      if (q.has("reset")) {
        q.delete("reset"); history.replaceState(null, "", location.pathname + (q.size ? `?${q}` : ""));
        await M.deleteDisk(root.disk).catch(() => {});
      }
      // This tab holds the disk while its machine runs; a reset left pending by the last page is done now, before Nanite opens it.
      diskHold = await M.holdDisk(root.disk);
      if (M.takeReset(root.disk)) {
        if (!diskHold.held) t.write(`\r\n${C.red}reset failed:${C.off} ${root.name} is open in another tab of the webshell: close that tab, then reset again\r\n`);
        else await M.deleteDisk(root.disk).then(() => t.write(`\r\n[disk deleted; starting a fresh ${root.name}]\r\n`),
          (e) => t.write(`\r\n${C.red}reset failed:${C.off} ${(e as Error).message}\r\n`));
      } else if (!diskHold.held) t.write(`\r\n${C.pink}warning:${C.off} ${root.name} is also open in another tab of the webshell; changes from the two can overwrite each other\r\n`);
      navigator.storage.persist?.().catch(() => {});

      t.write("\r\n");
      const bars = new Bars(t), bN = bars.add("nanite"), bR = bars.add("rootfs");
      bN.note = "loading"; bR.note = root.name; bars.draw();

      const [mod, wisp] = await Promise.all([M.loadNanite(launch.pkg), M.nearestWisp(launch)]);
      w.wisp = wisp; relay = wisp;
      const hooks: M.Hooks = { onOutput, onMemoryEvent, onFrame: (fw, fh, px) => monitor?.frame(fw, fh, px), onTerminalExit };
      // The screen: the size from the settings, or else the monitor tab's.
      screen = launch.screenWidth && launch.screenHeight ? { width: launch.screenWidth, height: launch.screenHeight } : monitor!.areaSize();
      const start = async () => {
        nv = await M.createMachine(mod, $state.snapshot(launch), wisp.url, { width: screen.width, height: screen.height }, root.disk, hooks); w.nv = nv; w.memReport = () => M.memReport(nv!);
        nv.worker.addEventListener("message", (e) => { if (e.data?.ev === "wisp") wispDown = e.data.state === "down"; });
        return nv;
      };
      let cur = await start();
      mark("naniteReady");
      bN.f = 1; bN.note = `ready · wisp ${wisp.name}`; bars.draw();

      if (cur.rootMounted) {
        bR.f = 1; bR.note = `${root.name} · from disk`; bars.draw();
      } else {
        // First start of this root: stream its image (gzip, inflated natively) straight onto the disk.
        const img = await image((state) => { bR.note = `${root.name} · ${state} on the server`; bars.draw(); });
        let got = 0;
        const counted = img.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(c, ctl) {
          got += c.length; bR.f = img.total ? got / img.total : null; bR.note = `${root.name} · ${M.mb(got * (img.scale ?? 1))}${img.total ? ` / ${M.mb(img.total * (img.scale ?? 1))}` : ""} MB`; bars.draw(); ctl.enqueue(c);
        } }));
        await cur.loadTarStream(img.gz ? counted.pipeThrough(new DecompressionStream("gzip") as unknown as TransformStream<Uint8Array, Uint8Array>) : counted);
        await cur.loadTar(M.tarFile("etc/resolv.conf", "nameserver 1.1.1.1\nnameserver 8.8.8.8\n"));
        await cur.flush();
        if (root.source.kind === "file") await roots.dropSource(root.id);
        if (root.source.kind === "ffs") void forgetFfsCache(root.source.url);
        // Start the machine again on the disk it just wrote. Nanite's device nodes (/dev/fb0, input/, pts/, snd/) are dead after
        // the first image load into a fresh disk root; registered on a mounted disk (as on every later visit) they work.
        // (A root kept in memory only would be lost by the restart: that machine goes on as it is.)
        if (launch.rootStorage !== "memory") { cur.terminate(); cur = await start(); }
        bR.f = 1; bR.note = `${root.name} · saved to disk`; bars.draw();
      }
      mark("rootLoaded");
      // What this root has: root's login shell (fish, bash, or else /bin/sh: Alpine, many Docker images) and Perl (VS Code's
      // file server).
      const { code } = await cur.run(["/bin/sh", "-c",
        "b=0; p=0; f=0; [ -x /bin/bash ] && b=1; [ -x /usr/bin/perl ] && p=2; grep -q '^root:.*/fish$' /etc/passwd && [ -x /usr/bin/fish ] && f=4; exit $((b + p + f))"],
        M.shells("sh").env);
      sh = M.shells(code & 4 ? "fish" : code & 1 ? "bash" : "sh"); hasPerl = (code & 2) === 2;
      try { stopPing = M.pingBridge(cur, wisp.url); } catch (e) { console.warn("ping bridge:", e); }

      t.write("\x1b[2J\x1b[3J\x1b[H");
      booted = true;
      tunnels.startAll();
      if (playit.hasSecret) void playit.start();
      await shell();
    } catch (e) {
      t.write(`\r\n${C.red}error:${C.off} ${(e as Error)?.message ?? e}\r\n`);
      bootError = (e as Error)?.message ?? String(e);
      console.error(e);
    }
  }

  // Pills: the tabs and buttons of the top bar; the menu button is a rounded square, in the accent only while its menu is open.
  const pill = "group relative flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs transition-colors";
  const iconBtn = "grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-sakura/15 hover:text-sakura disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted";
  const item = "flex w-full items-center gap-2.5 rounded-full px-3 py-1.5 text-left text-xs text-fg hover:bg-sakura/15 hover:text-sakura disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg";
  const sep = "mx-3 my-1 border-t border-line";
</script>

<div class="relative flex h-full flex-col">
  {#if barHidden && !barPeek}
    <!-- The bar is hidden: the top edge brings it back while the pointer is there. -->
    <div class="absolute inset-x-0 top-0 z-40 h-1.5 bg-gradient-to-b from-sakura/30 to-transparent opacity-0 transition-opacity hover:opacity-100"
      role="presentation" onmouseenter={peekSoon} onmouseleave={peekCancel}></div>
  {/if}
  <nav class="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-bar px-2 select-none
    {barHidden ? `absolute inset-x-0 top-0 z-40 transition-[translate,box-shadow] duration-200 ease-out ${barPeek ? 'translate-y-0 shadow-xl shadow-black/40' : 'pointer-events-none -translate-y-full'}` : ''}"
    aria-hidden={barHidden && !barPeek} inert={barHidden && !barPeek}
    onmouseleave={() => { if (!menuOpen && !plusOpen) barPeek = false; }}>
    <div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]" role="tablist" tabindex="-1"
      ondragover={(e) => { if (dragTab && (winOf(dragTab)?.tree.type === "split")) { e.preventDefault(); dropWin = "new"; } }}
      ondragleave={(e) => { if (dropWin === "new" && e.target === e.currentTarget) dropWin = null; }} ondrop={(e) => { e.preventDefault(); if (dropWin === "new") dropIntoWin(null); else dragEnd(); }}>
      {#each wins as wv (wv.id)}
        {@const v = P.findLeaf(wv.tree, wv.focus)?.tab ?? viewsOf(wv)[0]!}
        {@const kind = tabs.find((t) => t.id === v)?.kind}
        {@const n = P.leaves(wv.tree).length}
        {@const closable = winClosable(wv)}
        <!-- The whole pill is the tab (all of its panes): a click anywhere on it opens it (middle click closes); its × only closes.
             A pane dragged onto it joins it. -->
        <div role="tab" tabindex="0" aria-selected={curWin === wv.id} title={viewsOf(wv).map((x) => titles[x]).join(" · ")} draggable="true"
          ondragstart={(e) => dragWinStart(e, wv.id)} ondragend={dragEnd}
          animate:flip={{ duration: motion(180) }} in:scale={{ start: 0.85, duration: motion(160) }}
          class="{pill} outline-none focus-visible:ring-1 focus-visible:ring-sakura {curWin === wv.id ? 'bg-bg text-sakura ring-1 ring-line' : 'text-muted hover:bg-raised/60 hover:text-fg'} {closable ? 'pr-1' : ''} {dropWin === wv.id ? 'ring-2 ring-sakura/70' : ''}"
          onclick={() => (curWin = wv.id)} onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); curWin = wv.id; } }}
          onauxclick={(e) => { if (e.button === 1) closeWin(wv); }} onmousedown={(e) => { if (e.button === 1) e.preventDefault(); }}
          ondragover={(e) => { if (dragWin) reorderOver(e, wv.id); else if (dragTab && winOf(dragTab)?.id !== wv.id) { e.preventDefault(); e.stopPropagation(); dropWin = wv.id; } }}
          ondragleave={() => { if (dropWin === wv.id) dropWin = null; if (reorder?.id === wv.id) reorder = null; }}
          ondrop={(e) => { if (dragWin) reorderDrop(e); else { e.preventDefault(); e.stopPropagation(); dropIntoWin(wv.id); } }}>
          {#if reorder?.id === wv.id}<span class="pointer-events-none absolute inset-y-1 {reorder.after ? '-right-[3px]' : '-left-[3px]'} w-[3px] rounded-full bg-sakura"></span>{/if}
          {#if kind === "monitor"}<Monitor size={14} class="shrink-0" />{:else if kind === "code"}<Code size={14} class="shrink-0" />{:else if kind === "preview"}<Globe size={14} class="shrink-0" />{:else}<TerminalIcon size={14} class="shrink-0" />{/if}
          <span class="max-w-[22ch] truncate">{titles[v]}</span>
          {#if n > 1}<span class="rounded-full bg-raised px-1.5 text-[10px] text-muted" title="{n} panes">{n}</span>{/if}
          {#if viewsOf(wv).some((x) => belled[x])}<span in:scale={{ duration: motion(200) }} class="grid"><Bell size={12} class="shrink-0 animate-pulse text-sakura" aria-label="the bell rang" /></span>{/if}
          {#if closable}
            <button class="grid h-5 w-5 place-items-center rounded-full text-muted opacity-60 hover:bg-line hover:text-sakura hover:opacity-100 group-hover:opacity-100"
              title={n > 1 ? "Close this tab and its panes" : "Close"} aria-label="Close {titles[v]}" onclick={(e) => { e.stopPropagation(); closeWin(wv); }}><X size={12} /></button>
          {/if}
        </div>
      {/each}
      <div class="relative shrink-0" data-plus>
        <button class={iconBtn} title={booted ? "New tab" : "New tab (once the machine is up)"} disabled={!booted} aria-haspopup="menu" aria-expanded={plusOpen}
          onclick={(e) => { plusX = Math.min((e.currentTarget as HTMLElement).getBoundingClientRect().left, innerWidth - 200); plusOpen = !plusOpen; }}><Plus size={15} /></button>
      </div>
    </div>

    {#if wispDown}<span transition:fly={{ x: 8, duration: motion(160) }} class="flex items-center gap-1.5 rounded-full bg-raised px-2.5 py-1 text-[11px] text-sakura" title="The network (Wisp) dropped: reconnecting. Connections open at the drop were closed."><RefreshCw size={13} class="animate-spin" />reconnecting</span>{/if}
    {#if !online}<span transition:fly={{ x: 8, duration: motion(160) }} class="flex items-center gap-1.5 rounded-full bg-raised px-2.5 py-1 text-[11px] text-muted" title="Offline: the app runs from its cache; the machine has no network"><WifiOff size={13} />offline</span>{/if}
    <button class={iconBtn} title="Split right: a new terminal beside this pane (or drag a tab onto a pane's edge)" disabled={!booted} onclick={() => splitPane("right")}><Columns2 size={15} /></button>
    <button class={iconBtn} title="Split down: a new terminal below this pane" disabled={!booted} onclick={() => splitPane("bottom")}><Rows2 size={15} /></button>
    <button class={iconBtn} title={barHidden ? "Keep the bar (Ctrl+Shift+B)" : "Hide the bar (Ctrl+Shift+B)"} onclick={toggleBar}>
      {#if barHidden}<PanelTopOpen size={15} />{:else}<PanelTopClose size={15} />{/if}
    </button>
    <div class="relative shrink-0" data-menu>
      <button class="grid h-8 w-8 place-items-center rounded-lg text-muted transition-[background-color,color,transform] duration-150 hover:bg-sakura/15 hover:text-sakura active:scale-95 aria-expanded:bg-sakura aria-expanded:text-bar"
        title="Menu" aria-haspopup="menu" aria-expanded={menuOpen} onclick={() => (menuOpen = !menuOpen)}><Menu size={16} /></button>
      {#if menuOpen}
        <div role="menu" transition:fly={{ y: -6, duration: motion(140) }} class="absolute top-full right-0 z-20 mt-2 w-52 rounded-3xl border border-line bg-panel p-1.5 shadow-xl shadow-black/50">
          <button role="menuitem" class={item} title="Download this root's disk as a .tar.gz" onclick={() => { menuOpen = false; void saveDisk(); }}><Save size={14} />Save disk</button>
          <button role="menuitem" class={item} title="Replace this root's disk with a saved .tar.gz" onclick={() => { menuOpen = false; fileInput.click(); }}><FolderOpen size={14} />Load disk</button>
          <button role="menuitem" class="{item} hover:!bg-danger/15 hover:!text-danger" title="Delete this root's disk and start fresh" onclick={() => { menuOpen = false; void resetDisk(); }}><RotateCcw size={14} />Reset</button>
          <div class={sep}></div>
          <button role="menuitem" class={item} disabled={booted && !hasPerl} title={booted && !hasPerl ? "Needs Perl on this root (VS Code's file server)" : "The whole window is VS Code on this machine (until you disable it)"}
            onclick={() => setCodeMode(true)}><Maximize2 size={14} />VS Code mode</button>
          <button role="menuitem" class={item} title="Nanite, Network, Terminal and Storage" onclick={() => openSettings(settingsTab)}><SettingsIcon size={14} />Settings<span class="ml-auto truncate text-[10px] text-muted">{root.name}</span></button>
          <div class={sep}></div>
          <a role="menuitem" class={item} href="https://github.com/WorldEditAxe/webshell" target="_blank" rel="noopener" title="The source on GitHub (opens in a new tab)"
            onclick={() => (menuOpen = false)}><GitBranch size={14} />GitHub<ExternalLink size={12} class="ml-auto text-muted" aria-label="opens in a new tab" /></a>
        </div>
      {/if}
    </div>
    <input type="file" accept=".gz,.tgz,application/gzip" hidden bind:this={fileInput} onchange={pickedFile} />
  </nav>

  {#if plusOpen}
    <div role="menu" data-plus transition:fly={{ y: -6, duration: motion(140) }} class="fixed z-30 w-48 rounded-3xl border border-line bg-panel p-1.5 shadow-xl shadow-black/50" style="left: {plusX}px; top: 46px">
      <button role="menuitem" class={item} onclick={() => newTab()}><TerminalIcon size={14} />Terminal</button>
      <button role="menuitem" class={item} disabled={!hasPerl} title={hasPerl ? "VS Code on this machine" : "Needs Perl on this root (its file server)"} onclick={openCode}><Code size={14} />VS Code</button>
      <button role="menuitem" class={item} title="Web sites, and web servers in the machine (localhost:PORT)" onclick={openPreview}><Globe size={14} />Web Browser</button>
      {#if !monitorOpen}<button role="menuitem" class={item} onclick={openMonitor}><Monitor size={14} />Display</button>{/if}
    </div>
  {/if}

  <main bind:this={mainEl} class="relative min-h-0 flex-1 bg-bg" onpointerdowncapture={(e) => { const p = paneAt(e.clientX, e.clientY); if (p && p !== focus) setFocus(p); }}>
    <!-- Every tab stays mounted, positioned over the pane that shows it (lib/panes.ts): moving it between panes does not reload it. -->
    {#each tabs as tab (tab.id)}
      <div class="absolute overflow-hidden {shown.has(tab.id) ? '' : 'pointer-events-none invisible'}" style={boxOf(tab.id)} data-tab={tab.id}>
        {#if tab.kind === "term" && tab.shell}
          <TerminalView shell={tab.shell} active={shown.has(tab.id)} dispose={tab.closable} />
        {:else if tab.kind === "code" && nv}
          <CodeView {nv} {sh} active={shown.has(tab.id)} {openPty} {closePty} {fileServer} info={() => ({ root: root.name, memory: launch.memory })} onstorage={() => openSettings("storage")} />
        {:else if tab.kind === "preview"}
          <PreviewView active={shown.has(tab.id)} ontitle={(t) => (titles[tab.id] = t)} />
        {/if}
      </div>
    {/each}
    <!-- The monitor stays mounted when its tab is closed: the machine's screen keeps its size, and its first picture is noticed. -->
    <div class="absolute overflow-hidden {shown.has('monitor') ? '' : 'pointer-events-none invisible'}" style={boxOf("monitor")} data-tab="monitor">
      <MonitorView bind:this={monitor} {nv} active={shown.has("monitor") && monitorOpen} {screen} mouse={launch.mouse} follow={!(launch.screenWidth && launch.screenHeight)} onfit={fitScreen} ondraw={onDraw} />
    </div>

    {#if multi}
      <!-- Each pane's header: its view (drag it onto another pane, another tab in the bar, or the bar's empty space), split, close. -->
      {#each [...lay.panes] as [pid, p] (pid)}
        {@const t = tabs.find((x) => x.id === p.tab)}
        <div class="absolute z-10 flex items-center gap-1.5 border-b px-2 text-[11px] select-none {focus === pid ? 'border-sakura/50 bg-panel text-sakura' : 'border-line bg-bar text-muted'}"
          style="left:{p.x * 100}%;top:{p.y * 100}%;width:{p.w * 100}%;height:{HDR}px" draggable="true" role="presentation"
          ondragstart={(e) => dragStart(e, p.tab)} ondragend={dragEnd} onclick={() => setFocus(pid)}>
          {#if t?.kind === "monitor"}<Monitor size={12} class="shrink-0" />{:else if t?.kind === "code"}<Code size={12} class="shrink-0" />{:else if t?.kind === "preview"}<Globe size={12} class="shrink-0" />{:else}<TerminalIcon size={12} class="shrink-0" />{/if}
          <span class="min-w-0 flex-1 cursor-grab truncate">{titles[p.tab]}</span>
          <button class="grid h-5 w-5 shrink-0 place-items-center rounded-full hover:bg-sakura/15 hover:text-sakura" title="Split right" disabled={!booted} onclick={(e) => { e.stopPropagation(); splitPane("right", pid); }}><Columns2 size={12} /></button>
          <button class="grid h-5 w-5 shrink-0 place-items-center rounded-full hover:bg-sakura/15 hover:text-sakura" title="Split down" disabled={!booted} onclick={(e) => { e.stopPropagation(); splitPane("bottom", pid); }}><Rows2 size={12} /></button>
          {#if t?.closable}<button class="grid h-5 w-5 shrink-0 place-items-center rounded-full hover:bg-sakura/15 hover:text-sakura" title="Close this pane" onclick={(e) => { e.stopPropagation(); closeTab(p.tab); }}><X size={12} /></button>{/if}
        </div>
      {/each}
      {#each lay.dividers as d (d.split + ":" + d.index)}
        <div class="absolute z-20 {d.dir === 'row' ? 'cursor-col-resize' : 'cursor-row-resize'} group" role="separator" aria-orientation={d.dir === "row" ? "vertical" : "horizontal"}
          style={d.dir === "row" ? `left:calc(${d.rect.x * 100}% - 3px);top:${d.rect.y * 100}%;width:6px;height:${d.rect.h * 100}%` : `left:${d.rect.x * 100}%;top:calc(${d.rect.y * 100}% - 3px);width:${d.rect.w * 100}%;height:6px`}
          onpointerdown={(e) => startResize(e, d)}>
          <div class="absolute bg-line transition-colors group-hover:bg-sakura/70 {resizing === d ? 'bg-sakura' : ''} {d.dir === 'row' ? 'inset-y-0 left-[2.5px] w-px' : 'inset-x-0 top-[2.5px] h-px'}"></div>
        </div>
      {/each}
    {/if}
    {#if resizing}<div class="absolute inset-0 z-30 {resizing.dir === 'row' ? 'cursor-col-resize' : 'cursor-row-resize'}"></div>{/if}
    {#if dragTab || dragWin}
      <!-- Drop zones over the panes (over their frames too): the middle shows the tab there, an edge splits the pane. -->
      {#each [...lay.panes] as [pid, p] (pid)}
        <div class="absolute z-40" style={pct(p)} role="presentation"
          ondragover={(e) => { e.preventDefault(); const zone = zoneAt(e, e.currentTarget as HTMLElement); if (drop?.pane !== pid || drop.zone !== zone) snap(0.35); drop = { pane: pid, zone }; }}
          ondragleave={() => { if (drop?.pane === pid) drop = null; }} ondrop={(e) => { e.preventDefault(); dropTab(); }}>
          {#if drop?.pane === pid}<div class="pointer-events-none absolute rounded-xl border-2 border-sakura/70 bg-sakura/15 transition-all duration-100 {zoneRect[drop.zone]}"></div>{/if}
        </div>
      {/each}
    {/if}

    {#if drawHint && !monitorOpen}
      <div transition:fly={{ y: 16, duration: motion(200) }} class="absolute right-4 bottom-4 z-20 flex items-center gap-2 rounded-full border border-sakura/40 bg-panel py-1.5 pr-1.5 pl-3 text-xs shadow-xl shadow-black/50">
        <MonitorUp size={15} class="text-sakura" />
        <span>Something is on the screen</span>
        <button class="rounded-full bg-sakura px-3 py-1 font-bold text-bar hover:brightness-110" onclick={openMonitor}>Open</button>
        <button class={iconBtn} title="Dismiss" onclick={() => (drawHint = false)}><X size={13} /></button>
      </div>
    {/if}
  </main>
</div>

{#if codeMode}
  <!-- VS Code mode: over everything (the machine and its tabs keep running underneath). -->
  <div class="fixed inset-0 z-50 bg-bg">
    {#if nv && booted && hasPerl}
      <CodeView {nv} {sh} active={true} {openPty} {closePty} {fileServer} info={() => ({ root: root.name, memory: launch.memory })}
        onstorage={() => openSettings("storage")} codeMode={true} ondisablemode={() => setCodeMode(false)} />
    {:else}
      <div class="grid h-full place-items-center text-xs text-muted">
        <div class="grid justify-items-center gap-3">
          {#if bootError}<p class="max-w-md text-center text-danger">{bootError}</p>{:else}<LoaderCircle size={18} class="animate-spin text-sakura" /><p>starting the machine for VS Code…</p>{/if}
          <button class="rounded-full px-3 py-1 text-muted ring-1 ring-line hover:text-sakura" onclick={() => setCodeMode(false)}>Disable VS Code mode</button>
        </div>
      </div>
    {/if}
  </div>
{/if}
{#if memNotice}
  <div role="alert" transition:fly={{ y: 16, duration: motion(200) }} class="fixed right-4 bottom-4 z-[60] flex max-w-md items-start gap-3 rounded-3xl border border-danger/50 bg-panel p-3 pl-4 text-xs shadow-xl shadow-black/50">
    <MemoryStick size={16} class="mt-0.5 shrink-0 text-danger" />
    <div class="grid min-w-0 gap-1.5">
      <p class="text-fg">Nanite has ran out of system memory. It is strongly recommended that you increase the amount of memory allocated to the system for applications to continue working.</p>
      <p class="text-muted">{memNotice.detail}{memNotice.n > 1 ? ` (${memNotice.n} times)` : ""}</p>
      <div class="flex gap-1.5">
        <button class="rounded-full bg-sakura px-3 py-1 font-bold text-bar hover:brightness-110" onclick={() => { memNotice = null; openSettings("nanite"); }}>Increase memory</button>
        <button class="rounded-full px-3 py-1 text-muted hover:text-fg" onclick={() => (memNotice = null)}>Dismiss</button>
      </div>
    </div>
  </div>
{/if}

<SettingsDialog bind:open={settingsOpen} bind:tab={settingsTab} current={launch} {root} {tunnels} {playit} {relay} {booted}
  onapply={applySettings} onswitch={switchRoot} onresetcurrent={() => void resetNow()} onsave={() => void saveDisk()} onload={() => fileInput.click()} />
<AskDialog />
