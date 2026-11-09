<!-- Nanite Webshell: a Linux root filesystem (Ubuntu 26.04 LTS by default; lib/roots.ts) on Nanite, in xterm.js. A top bar
     with the tabs (the main terminal stays; more terminals, VS Code and the monitor open from + and close), and a menu with the
     disk's save / load / reset and the settings (lib/SettingsDialog.svelte). -->
<script lang="ts">
  import { onMount, tick } from "svelte";
  import { fly, scale } from "svelte/transition";
  import { flip } from "svelte/animate";
  import { motion } from "./lib/motion";
  import {
    Terminal as TerminalIcon, Monitor, Plus, X, Menu, Save, FolderOpen, RotateCcw, Code, Settings as SettingsIcon, Bell, MonitorUp,
    PanelTopClose, PanelTopOpen, WifiOff, RefreshCw, ExternalLink, GitBranch,
  } from "@lucide/svelte";
  import TerminalView from "./lib/TerminalView.svelte";
  import MonitorView from "./lib/MonitorView.svelte";
  import SettingsDialog from "./lib/SettingsDialog.svelte";
  import AskDialog from "./lib/AskDialog.svelte";
  import CodeView from "./lib/CodeView.svelte";
  import { Bars, C, Shell } from "./lib/term";
  import * as settings from "./lib/settings";
  import * as M from "./lib/machine";
  import * as roots from "./lib/roots";
  import { theme, applyTheme } from "./lib/themes";
  import { ffsTar, forgetFfsCache } from "./lib/ffsroot";
  import { ask } from "./lib/ask.svelte";
  import { FSD, GuestFiles } from "./lib/files";

  type Tab = { id: string; kind: "term" | "monitor" | "code"; shell?: Shell; termId?: number; closable: boolean };
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
    { id: "monitor", kind: "monitor", closable: true },
  ]);
  let active = $state("main");
  let titles = $state<Record<string, string>>({ main: root.name, monitor: "monitor" });
  let belled = $state<Record<string, boolean>>({});
  let nv = $state.raw<M.Nanite | null>(null);
  let booted = $state(false);
  let sh = $state.raw<M.Shells>(M.shells("bash"));
  let hasPerl = $state(true);
  let plusX = $state(0);
  let menuOpen = $state(false), plusOpen = $state(false), settingsOpen = $state(false);
  let settingsTab = $state<"nanite" | "terminal" | "storage">("nanite");
  let monitor = $state<MonitorView>();
  let screen = $state({ width: 0, height: 0 });
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
  let fileInput: HTMLInputElement;
  let busy = false, counter = 1, stopPing = () => {};
  // Nanite's terminals (openTerminal) by id: where their output goes and what to do when they end. Output that arrives before
  // openTerminal has answered waits in `pending`.
  const terms = new Map<number, { sink: (b: Uint8Array) => void; onExit?: () => void }>();
  const pending = new Map<number, Uint8Array[]>(), gone = new Set<number>();
  const monitorOpen = $derived(tabs.some((t) => t.id === "monitor"));

  /** Flags a tab whose terminal rang its bell while another tab was shown. */
  const flagBell = (id: string) => () => { if (active !== id || document.hidden) belled[id] = true; };
  $effect(() => { if (belled[active]) belled[active] = false; });

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
  async function newTab(): Promise<void> {
    plusOpen = false;
    if (!nv || !booted) return;
    const cur = nv, n = ++counter, id = `t${n}`, s = new Shell(settings.terminalOptions(launch));
    tabs = [...tabs, { id, kind: "term", shell: s, closable: true }];
    titles[id] = `shell ${n}`; active = id;
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
        // perl -e as the session leader, which never execs (the openTerminal bug in reports/nanite-bugs.md).
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
    titles[id] = n === 1 ? "VS Code" : `VS Code ${n}`; active = id;
  }
  function openMonitor(): void {
    plusOpen = false; drawHint = false;
    if (!monitorOpen) tabs = [...tabs.slice(0, 1), { id: "monitor", kind: "monitor", closable: true }, ...tabs.slice(1)];
    active = "monitor";
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
    if (id === "monitor") titles.monitor = "monitor";
    if (active === id) active = tabs[Math.min(i, tabs.length - 1)]!.id;
  }
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
  }
  async function act(name: string, f: () => Promise<void>): Promise<void> {
    if (busy) return; busy = true; menuOpen = false; active = "main";
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
    await M.deleteDisk(root.disk);
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
  // The screen's size is fixed while the machine runs: matching a resized window takes a restart.
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
      navigator.storage.persist?.().catch(() => {});

      t.write("\r\n");
      const bars = new Bars(t), bN = bars.add("nanite"), bR = bars.add("rootfs");
      bN.note = "loading"; bR.note = root.name; bars.draw();

      const [mod, wisp] = await Promise.all([M.loadNanite(launch.pkg), M.nearestWisp(launch.wisp)]);
      w.wisp = wisp;
      const hooks: M.Hooks = { onOutput, onFrame: (fw, fh, px) => monitor?.frame(fw, fh, px), onTerminalExit };
      // The screen: the size from the settings, or else the monitor tab's.
      screen = launch.screenWidth && launch.screenHeight ? { width: launch.screenWidth, height: launch.screenHeight } : monitor!.areaSize();
      const start = async () => {
        nv = await M.createMachine(mod, $state.snapshot(launch), wisp.url, { width: screen.width, height: screen.height }, root.disk, hooks); w.nv = nv;
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
        cur.terminate(); cur = await start();
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
      await shell();
    } catch (e) {
      t.write(`\r\n${C.red}error:${C.off} ${(e as Error)?.message ?? e}\r\n`);
      console.error(e);
    }
  }

  // Pills: the tabs and buttons of the top bar; the menu button is a rounded square shaded in the accent.
  const pill = "group flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs transition-colors";
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
    <div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]" role="tablist">
      {#each tabs as tab (tab.id)}
        <!-- The whole pill is the tab: a click anywhere on it selects it (middle click closes); its × only closes. -->
        <div role="tab" tabindex="0" aria-selected={active === tab.id} title={titles[tab.id]}
          animate:flip={{ duration: motion(180) }} in:scale={{ start: 0.85, duration: motion(160) }}
          class="{pill} outline-none focus-visible:ring-1 focus-visible:ring-sakura {active === tab.id ? 'bg-bg text-sakura ring-1 ring-line' : 'text-muted hover:bg-raised/60 hover:text-fg'} {tab.closable ? 'pr-1' : ''}"
          onclick={() => (active = tab.id)} onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); active = tab.id; } }}
          onauxclick={(e) => { if (e.button === 1) closeTab(tab.id); }} onmousedown={(e) => { if (e.button === 1) e.preventDefault(); }}>
          {#if tab.kind === "monitor"}<Monitor size={14} class="shrink-0" />{:else if tab.kind === "code"}<Code size={14} class="shrink-0" />{:else}<TerminalIcon size={14} class="shrink-0" />{/if}
          <span class="max-w-[22ch] truncate">{titles[tab.id]}</span>
          {#if belled[tab.id]}<span in:scale={{ duration: motion(200) }} class="grid"><Bell size={12} class="shrink-0 animate-pulse text-sakura" aria-label="the bell rang" /></span>{/if}
          {#if tab.closable}
            <button class="grid h-5 w-5 place-items-center rounded-full text-muted opacity-60 hover:bg-line hover:text-sakura hover:opacity-100 group-hover:opacity-100"
              title="Close" aria-label="Close {titles[tab.id]}" onclick={(e) => { e.stopPropagation(); closeTab(tab.id); }}><X size={12} /></button>
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
    <button class={iconBtn} title={barHidden ? "Keep the bar (Ctrl+Shift+B)" : "Hide the bar (Ctrl+Shift+B)"} onclick={toggleBar}>
      {#if barHidden}<PanelTopOpen size={15} />{:else}<PanelTopClose size={15} />{/if}
    </button>
    <div class="relative shrink-0" data-menu>
      <button class="grid h-8 w-8 place-items-center rounded-lg border border-sakura/40 bg-sakura/20 text-sakura transition-[background-color,color,transform] duration-150 hover:bg-sakura/30 active:scale-95 aria-expanded:bg-sakura aria-expanded:text-bar"
        title="Menu" aria-haspopup="menu" aria-expanded={menuOpen} onclick={() => (menuOpen = !menuOpen)}><Menu size={16} /></button>
      {#if menuOpen}
        <div role="menu" transition:fly={{ y: -6, duration: motion(140) }} class="absolute top-full right-0 z-20 mt-2 w-52 rounded-3xl border border-line bg-panel p-1.5 shadow-xl shadow-black/50">
          <button role="menuitem" class={item} title="Download this root's disk as a .tar.gz" onclick={() => { menuOpen = false; void saveDisk(); }}><Save size={14} />Save disk</button>
          <button role="menuitem" class={item} title="Replace this root's disk with a saved .tar.gz" onclick={() => { menuOpen = false; fileInput.click(); }}><FolderOpen size={14} />Load disk</button>
          <button role="menuitem" class="{item} hover:!bg-danger/15 hover:!text-danger" title="Delete this root's disk and start fresh" onclick={() => { menuOpen = false; void resetDisk(); }}><RotateCcw size={14} />Reset</button>
          <div class={sep}></div>
          <button role="menuitem" class={item} title="Nanite, Terminal and Storage" onclick={() => openSettings(settingsTab)}><SettingsIcon size={14} />Settings<span class="ml-auto truncate text-[10px] text-muted">{root.name}</span></button>
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
      <button role="menuitem" class={item} onclick={newTab}><TerminalIcon size={14} />Terminal</button>
      <button role="menuitem" class={item} disabled={!hasPerl} title={hasPerl ? "VS Code on this machine" : "Needs Perl on this root (its file server)"} onclick={openCode}><Code size={14} />VS Code</button>
      {#if !monitorOpen}<button role="menuitem" class={item} onclick={openMonitor}><Monitor size={14} />Monitor</button>{/if}
    </div>
  {/if}

  <main class="relative min-h-0 flex-1 bg-bg">
    {#each tabs as tab (tab.id)}
      {#if tab.kind === "term" && tab.shell}
        <TerminalView shell={tab.shell} active={active === tab.id} dispose={tab.closable} />
      {:else if tab.kind === "code" && nv}
        <CodeView {nv} {sh} active={active === tab.id} {openPty} {closePty} {fileServer} info={() => ({ root: root.name, memory: launch.memory })} onstorage={() => openSettings("storage")} />
      {/if}
    {/each}
    <!-- The monitor stays mounted when its tab is closed: the machine's screen keeps its size, and its first picture is noticed. -->
    <MonitorView bind:this={monitor} {nv} active={active === "monitor" && monitorOpen} {screen} mouse={launch.mouse} onfit={fitScreen} ondraw={onDraw} />

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

<SettingsDialog bind:open={settingsOpen} bind:tab={settingsTab} current={launch} {root}
  onapply={applySettings} onswitch={switchRoot} onresetcurrent={() => void resetNow()} onsave={() => void saveDisk()} onload={() => fileInput.click()} />
<AskDialog />
