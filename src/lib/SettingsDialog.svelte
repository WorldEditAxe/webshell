<!-- Settings, in tabs: Nanite (the emulator's launch parameters: saving restarts the machine, the disk stays), Terminal (theme
     and terminal options: they apply at once), Storage (the root filesystems: switch, add from a Docker image / URL / file,
     reset, delete). Short labels and icons; the explanations are in the tooltips. -->
<script lang="ts">
  import DistroIcon from "./DistroIcon.svelte";
  import {
    X, Cpu, SquareTerminal, HardDrive, MemoryStick, Database, Monitor, Globe, Package, Type, MoveVertical, TextCursor, ScrollText,
    Bell, BellOff, Combine, Sparkles, Container, FileArchive, Link, Play, RotateCcw, Trash2, Upload, Plus,
    LoaderCircle, Check, Save, FolderOpen, CircleDot, Palette, Mouse, Move, MousePointer2, Skull, Layers, Blocks, Archive, Zap, Flame, Binary, Network, Radar, LocateFixed, ArrowRightLeft, CircleCheck, Power, Square, Activity, ChevronDown, Paintbrush, FileUp, ClipboardCopy,
  } from "@lucide/svelte";
  import { DEFAULTS, fromUrl, needsRestart, type Launch } from "./settings";
  import { fade, fly } from "svelte/transition";
  import { flip } from "svelte/animate";
  import { motion } from "./motion";
  import { allThemes, isUserTheme, parseThemes, saveUserThemes, deleteUserTheme, exportTheme, theme as themeById, type Theme } from "./themes";
  import * as roots from "./roots";
  import { ask } from "./ask.svelte";
  import * as M from "./machine";
  import * as W from "./wisp";
  import { type Tunnels, type Provider, type ProxyProtocol } from "./tunnels.svelte";
  import type { Playit } from "./playit.svelte";

  type Tab = "nanite" | "network" | "terminal" | "storage";
  let { open = $bindable(false), tab = $bindable<Tab>("nanite"), current, root, onapply, onswitch, onresetcurrent, onsave, onload, tunnels, playit, relay, booted }: {
    open: boolean; tab?: Tab; current: Launch; root: roots.Root;
    /** The machine's tunnels (lib/tunnels.svelte.ts), the relay it uses now, and whether it is up (tunnels need it). */
    tunnels: Tunnels; playit: Playit; relay: { url: string; name: string } | null; booted: boolean;
    onapply: (l: Launch) => void; onswitch: (id: string) => void; onresetcurrent: () => void; onsave: () => void; onload: () => void;
  } = $props();
  let dialog: HTMLDialogElement;
  let f = $state<Launch>({ ...DEFAULTS });
  const fromUrlNote = Object.entries(fromUrl()).map(([k, v]) => `${k}=${v}`).join(" ");

  $effect(() => {
    if (open && !dialog.open) { f = { ...current }; dialog.showModal(); void refreshRoots(); }
    else if (!open && dialog.open) dialog.close();
  });
  const num = (v: unknown) => (v === null || v === undefined || v === "" || Number.isNaN(+v!) ? null : +v!);
  function submit(e: SubmitEvent): void {
    e.preventDefault();
    const w = num(f.screenWidth), h = num(f.screenHeight);
    onapply({
      ...f,
      memory: num(f.memory) ?? DEFAULTS.memory, processMemory: num(f.processMemory), dcache: num(f.dcache), diskCache: num(f.diskCache) ?? DEFAULTS.diskCache,
      slotSize: num(f.slotSize),
      ...(w && h ? { screenWidth: w, screenHeight: h } : { screenWidth: null, screenHeight: null }),
      wisp: f.wisp.trim(), wispRouter: f.wispRouter.trim(), wispMode: f.wispMode === "server" && f.wisp.trim() ? "server" : "router", pkg: (f.pkg.trim() || DEFAULTS.pkg).replace(/\/$/, ""),
      fontSize: num(f.fontSize) ?? DEFAULTS.fontSize, lineHeight: num(f.lineHeight) ?? DEFAULTS.lineHeight, scrollback: num(f.scrollback) ?? DEFAULTS.scrollback,
    });
    open = false;
  }

  // ---- Network: the relay (auto: the nearest, found by lib/wisp.ts; or a URL), its tester, the tunnels ----
  let located = $state<Awaited<ReturnType<typeof W.locate>> | null>(null), locating = $state(false);
  let tests = $state<Record<string, W.WispTest | "running">>({});
  let tunnelPort = $state<number | null>(null), copied = $state("");
  // The new tunnel's provider, PROXY protocol and (own bore server) address and secret; the last choices are kept.
  const T_KEY = "nanite-webshell:tunnel-form";
  const tf0 = (() => { try { return JSON.parse(localStorage.getItem(T_KEY) ?? "{}"); } catch { return {}; } })();
  let tProvider = $state<Provider | "playit">(tf0.provider === "bore" || tf0.provider === "playit" ? tf0.provider : "bore.pub"), tProxy = $state<ProxyProtocol>(tf0.proxy ?? "off");
  let tServer = $state<string>(tf0.server ?? ""), tSecret = $state<string>(tf0.secret ?? "");
  const PROVIDERS: { id: Provider | "playit"; label: string; note: string }[] = [
    { id: "bore.pub", label: "bore.pub", note: "Public bore server: TCP, no account, a random public port." },
    { id: "bore", label: "Own bore server", note: "Your own `bore server` (any host with open ports), with or without --secret." },
    { id: "playit", label: "playit.gg", note: "TCP and UDP, with fixed addresses; needs a free playit.gg account. Tunnels (protocol, local port, PROXY protocol) are made on playit.gg." },
  ];
  const PROXIES: { id: ProxyProtocol; label: string }[] = [{ id: "off", label: "off" }, { id: "v1", label: "PROXY v1" }, { id: "v2", label: "PROXY v2" }];
  let reveal = $state(false);
  async function relocate(): Promise<void> { locating = true; try { located = await W.locate(f.wispRouter.trim()); } finally { locating = false; } }
  async function test(url: string): Promise<void> { tests[url] = "running"; tests[url] = await W.testWisp(url); }
  async function testAll(): Promise<void> {
    const urls = f.wispMode === "server" ? [f.wisp.trim()].filter(Boolean) : (located?.nodes ?? []).map((n) => n.url);
    await Promise.all(urls.map(test));
  }
  $effect(() => { if (open && tab === "network" && !located && !locating) void relocate(); });
  const tunnelReady = $derived(tProvider !== "playit" && !!num(tunnelPort) && (tProvider !== "bore" || !!tServer.trim()));
  function addTunnel(): void {
    const p = num(tunnelPort);
    if (!p || p < 1 || p > 65535 || !tunnelReady || tProvider === "playit") return;
    tunnels.add({ provider: tProvider, port: p, proxy: tProxy, ...(tProvider === "bore" ? { server: tServer.trim(), secret: tSecret || undefined } : {}) });
    try { localStorage.setItem(T_KEY, JSON.stringify({ provider: tProvider, proxy: tProxy, server: tServer, secret: tSecret })); } catch {}
    tunnelPort = null;
  }
  async function copy(text: string): Promise<void> { try { await navigator.clipboard.writeText(text); copied = text; setTimeout(() => (copied = ""), 1500); } catch {} }
  const ms = (n?: number | null) => (n == null ? "–" : `${n} ms`);
  /** A relay test's result after "ok", one string, so every " · " has its spaces. */
  const testSummary = (r: W.WispTest, full = false) => [
    `connect ${ms(r.connectMs)}`, `TCP ${ms(r.tcpMs)}`, `UDP ${r.udpMs == null ? "not offered" : ms(r.udpMs)}`,
    full && r.version ? `Wisp ${r.version}` : "", r.extensions?.join(", ") || "no extensions", full && r.motd ? `“${r.motd}”` : "",
  ].filter(Boolean).join(" · ");

  // ---- Themes: the built-in ones and the ones people make (import JSON / a Windows Terminal scheme, customize a copy, export) ----
  let themes = $state<Theme[]>(allThemes());
  let themePanel = $state<"" | "import" | "edit">(""), importText = $state(""), themeError = $state(""), themeNote = $state("");
  let draft = $state<Theme | null>(null);
  let themeFile = $state<HTMLInputElement>();
  const UI_LABELS: [keyof Theme["ui"], string][] = [["bg", "background"], ["fg", "text"], ["bar", "top bar"], ["panel", "panels"], ["raised", "raised"],
    ["line", "lines"], ["muted", "muted text"], ["sakura", "accent"], ["blossom", "accent 2"], ["danger", "danger"]];
  const TERM_KEYS = ["background", "foreground", "cursor", "selectionBackground", "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
    "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;
  function importThemes(text: string): void {
    themeError = "";
    try {
      const added = saveUserThemes(parseThemes(text));
      themes = allThemes(); f.theme = added[0]!.id; importText = ""; themePanel = "";
      themeNote = added.length > 1 ? `${added.length} themes added` : `“${added[0]!.name}” added`;
    } catch (e) { themeError = (e as Error).message; }
  }
  async function importFile(): Promise<void> {
    const file = themeFile?.files?.[0]; if (themeFile) themeFile.value = ""; if (!file) return;
    importThemes(await file.text());
  }
  function customize(): void {
    const t = themeById(f.theme);
    draft = JSON.parse(JSON.stringify({ ...t, name: isUserTheme(t.id) ? t.name : `${t.name} (mine)` }));
    themePanel = "edit"; themeError = "";
  }
  function saveDraft(): void { if (draft) importThemes(exportTheme(draft)); }
  function removeTheme(id: string): void { deleteUserTheme(id); themes = allThemes(); if (f.theme === id) f.theme = "gruvbox"; }
  async function copyTheme(): Promise<void> {
    try { await navigator.clipboard.writeText(exportTheme(themeById(f.theme))); themeNote = "theme JSON copied"; } catch { themeNote = "could not copy"; }
    setTimeout(() => (themeNote = ""), 2000);
  }

  // ---- Storage ----
  let list = $state<(roots.Root & { size: number })[]>([]);
  let usage = $state({ usage: 0, quota: 0 });
  let addKind = $state<"docker" | "url" | "file">("docker");
  let addValue = $state(""), adding = $state(""), addError = $state("");
  let fileInput = $state<HTMLInputElement>();
  async function refreshRoots(): Promise<void> {
    list = await Promise.all(roots.all().map(async (r) => ({ ...r, size: await roots.diskSize(r.disk) })));
    usage = await roots.estimate();
  }
  const gb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);
  async function resetRoot(r: roots.Root): Promise<void> {
    if (!(await ask({ title: `Reset ${r.name}?`, message: "Its disk is deleted; the next start unpacks a fresh image.", tone: "danger", confirm: "Reset" }))) return;
    if (r.id === root.id) { open = false; onresetcurrent(); return; }
    await M.deleteDisk(r.disk); await refreshRoots();
  }
  async function deleteRoot(r: roots.Root): Promise<void> {
    if (!(await ask({ title: `Delete ${r.name}?`, message: "The root and its disk are removed from this browser.", tone: "danger", confirm: "Delete" }))) return;
    await M.deleteDisk(r.disk); await roots.dropSource(r.id); roots.remove(r.id); await refreshRoots();
  }
  async function switchTo(r: roots.Root): Promise<void> {
    if (!(await ask({ title: `Switch to ${r.name}?`, message: "The machine restarts on it. Every root keeps its own disk.", confirm: "Switch" }))) return;
    open = false; onswitch(r.id);
  }
  async function add(): Promise<void> {
    addError = "";
    const v = addValue.trim();
    if (!v) return;
    try {
      if (addKind === "docker") {
        adding = "queued";
        await roots.dockerBuild(v, (s) => { adding = s.state; });
        roots.add({ name: v.includes(":") ? v : `${v}:latest`, icon: "docker", source: { kind: "docker", image: v } });
      } else {
        if (!/^https?:\/\//.test(v)) { addError = "an http(s) URL of a .tar.gz"; return; }
        roots.add({ name: decodeURIComponent(v.split("/").pop() || v).replace(/\.t(ar\.)?gz$/, ""), icon: "link", source: { kind: "url", url: v } });
      }
      addValue = ""; await refreshRoots();
    } catch (e) { addError = (e as Error).message; }
    finally { adding = ""; }
  }
  async function addFile(): Promise<void> {
    const file = fileInput?.files?.[0]; if (fileInput) fileInput.value = ""; if (!file) return;
    adding = "copying";
    try {
      const r = roots.add({ name: file.name.replace(/\.t(ar\.)?gz$/, ""), icon: "file", source: { kind: "file", name: file.name } });
      await roots.storeSource(r.id, file); await refreshRoots();
    } catch (e) { addError = (e as Error).message; }
    finally { adding = ""; }
  }

  const TABS: { id: Tab; label: string; icon: typeof Cpu }[] = [
    { id: "nanite", label: "Nanite", icon: Cpu }, { id: "network", label: "Network", icon: Network }, { id: "terminal", label: "Terminal", icon: SquareTerminal }, { id: "storage", label: "Storage", icon: HardDrive },
  ];
  const field = "w-full min-w-0 rounded-full border border-line bg-panel px-3.5 py-1.5 text-[13px] text-fg placeholder:text-muted/60 outline-none focus:border-blossom";
  const row = "flex items-center gap-3";
  const head = "mt-1 text-[10px] font-bold tracking-wider text-muted/70 uppercase first:mt-0";
  const lbl = "flex w-32 shrink-0 items-center gap-2 text-xs text-muted";
  const unit = "w-9 shrink-0 text-[11px] text-muted";
  const seg = (on: boolean) => `flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-colors ${on ? "bg-sakura/20 text-sakura ring-1 ring-sakura/40" : "text-muted hover:text-fg"}`;
  const iconBtn = "grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted hover:bg-sakura/15 hover:text-sakura disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-muted";
</script>

<dialog bind:this={dialog} onclose={() => (open = false)}
  class="m-auto w-[min(600px,calc(100vw-24px))] max-h-[calc(100vh-24px)] overflow-hidden rounded-3xl border border-line bg-bg p-0 text-fg shadow-2xl shadow-black/60 backdrop:bg-black/50 backdrop:backdrop-blur-[2px]">
  <form onsubmit={submit} class="flex max-h-[calc(100vh-24px)] flex-col">
    <header class="flex items-center gap-1 border-b border-line bg-bar px-3 py-2.5">
      {#each TABS as t (t.id)}
        <button type="button" class={seg(tab === t.id)} onclick={() => (tab = t.id)}><t.icon size={14} />{t.label}</button>
      {/each}
      <span class="flex-1"></span>
      <button type="button" class={iconBtn} title="Close" onclick={() => (open = false)}><X size={15} /></button>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
      {#if tab === "nanite"}
        <div class="grid gap-3" in:fly={{ x: 12, duration: motion(160) }}>
          <h3 class={head}>Memory</h3>
          <div class={row} title="The whole machine: kernel, every process, caches. apt needs 512.">
            <span class={lbl}><MemoryStick size={15} />Memory</span>
            <input class={field} type="number" min="128" step="64" required bind:value={f.memory} /><span class={unit}>MiB</span>
          </div>
          <div class={row} title="One program's memory cap. Empty: min(memory, 256).">
            <span class={lbl}><Cpu size={15} />Per process</span>
            <input class={field} type="number" min="32" step="32" placeholder="auto" bind:value={f.processMemory} /><span class={unit}>MiB</span>
          </div>
          <div class={row} title="When memory runs out: kill the process whose end frees the most (by resident memory and oom_score_adj, as Linux does; never init), or let the request fail (ENOMEM, fork EAGAIN). Either way a notice says what happened.">
            <span class={lbl}><Skull size={15} />OOM killer</span>
            <div class="flex gap-1">
              <button type="button" class={seg(f.oomKiller)} onclick={() => (f.oomKiller = true)}>on</button>
              <button type="button" class={seg(!f.oomKiller)} onclick={() => (f.oomKiller = false)}>off: fail</button>
            </div>
          </div>
          <div class={row} title="Per process: each process has a WebAssembly memory of its own. Single: one memory for all, cut into slots (one per process).">
            <span class={lbl}><Layers size={15} />Memory mode</span>
            <div class="flex gap-1">
              <button type="button" class={seg(f.memoryMode === "process")} onclick={() => (f.memoryMode = "process")}>per process</button>
              <button type="button" class={seg(f.memoryMode === "single")} onclick={() => (f.memoryMode = "single")}>single</button>
            </div>
          </div>
          {#if f.memoryMode === "single"}
            <div class={row} title="Each process's slot of the single memory. Empty: Nanite's default (512).">
              <span class={lbl}><Blocks size={15} />Slot size</span>
              <input class={field} type="number" min="16" step="16" placeholder="512" bind:value={f.slotSize} /><span class={unit}>MiB</span>
            </div>
          {/if}

          <h3 class={head}>Storage</h3>
          <div class={row} title="Where the root's files are kept. Disk: OPFS, else IndexedDB. Memory: nothing is kept; the image is unpacked at every start.">
            <span class={lbl}><HardDrive size={15} />Root</span>
            <div class="flex flex-wrap gap-1">
              {#each [["disk", "auto"], ["opfs", "OPFS"], ["indexeddb", "IndexedDB"], ["memory", "memory"]] as [v, label] (v)}
                <button type="button" class={seg(f.rootStorage === v)} onclick={() => (f.rootStorage = v as Launch["rootStorage"])}>{label}</button>
              {/each}
            </div>
          </div>
          <div class={row} title="The disk's file metadata kept in the kernel's memory. Empty: Nanite's default (16); 0: no bound.">
            <span class={lbl}><Database size={15} />Metadata</span>
            <input class={field} type="number" min="0" step="4" placeholder="16" bind:value={f.dcache} /><span class={unit}>MiB</span>
          </div>
          <div class={row} title="The code Nanite translated from x86-64. Disk: kept across visits (OPFS), so programs start fast next time. Memory: this visit only, in the page's memory. Off: translated at every start.">
            <span class={lbl}><Archive size={15} />Code cache</span>
            <div class="flex gap-1">
              {#each ["disk", "memory", "off"] as v (v)}
                <button type="button" class={seg(f.cacheBackend === v)} onclick={() => (f.cacheBackend = v as Launch["cacheBackend"])}>{v}</button>
              {/each}
            </div>
          </div>
          {#if f.cacheBackend === "memory"}
            <div class={row} title="The in-memory code cache, in this page's memory (outside the machine's memory). Nanite's own default: 64.">
              <span class={lbl}><Binary size={15} />Cache size</span>
              <input class={field} type="number" min="8" step="8" required bind:value={f.diskCache} /><span class={unit}>MiB</span>
            </div>
          {/if}

          <h3 class={head}>Engine</h3>
          <div class={row} title="JavaScript Promise Integration, where the browser has it: blocking calls without unwinding the stack.">
            <span class={lbl}><Zap size={15} />JSPI</span>
            <div class="flex gap-1">
              <button type="button" class={seg(f.jspi)} onclick={() => (f.jspi = true)}>when available</button>
              <button type="button" class={seg(!f.jspi)} onclick={() => (f.jspi = false)}>off</button>
            </div>
          </div>
          <div class={row} title="Translate the programs the guest is likely to run next ahead of time, in the compile workers.">
            <span class={lbl}><Flame size={15} />Prewarm</span>
            <div class="flex gap-1">
              <button type="button" class={seg(f.prewarm)} onclick={() => (f.prewarm = true)}>on</button>
              <button type="button" class={seg(!f.prewarm)} onclick={() => (f.prewarm = false)}>off</button>
            </div>
          </div>

          <h3 class={head}>Display and packages</h3>
          <div class={row} title="The screen size. Empty: it follows the Display tab's size (a desktop on /dev/dri/card0 takes it as you resize). Set: fixed at this size.">
            <span class={lbl}><Monitor size={15} />Screen</span>
            <input class={field} type="number" min="320" step="8" placeholder="auto" aria-label="Width" bind:value={f.screenWidth} />
            <span class="text-muted">×</span>
            <input class={field} type="number" min="200" step="8" placeholder="auto" aria-label="Height" bind:value={f.screenHeight} /><span class={unit}>px</span>
          </div>
          <div class={row} title="Relative: the pointer is captured (Esc releases) and moves the guest's cursor like a real mouse. Absolute: the guest's cursor follows where you point, without capture (best with pointer acceleration off, as ~/screen/install-desktop.sh sets up).">
            <span class={lbl}><Mouse size={15} />Mouse</span>
            <div class="flex gap-1">
              <button type="button" class={seg(f.mouse === "relative")} onclick={() => (f.mouse = "relative")}><Move size={13} />relative</button>
              <button type="button" class={seg(f.mouse === "absolute")} onclick={() => (f.mouse = "absolute")}><MousePointer2 size={13} />absolute</button>
            </div>
          </div>
          <div class={row} title="Nanite is loaded from <host>/lib/nanitevisor/.">
            <span class={lbl}><Package size={15} />Package host</span>
            <input class={field} type="url" required bind:value={f.pkg} /><span class={unit}></span>
          </div>
          {#if fromUrlNote}<p class="flex items-center gap-2 text-[11px] text-muted" title="Set in the page's URL: these win over what is saved here"><Link size={13} class="text-sakura" /><code class="text-sakura">{fromUrlNote}</code></p>{/if}
        </div>
      {:else if tab === "network"}
        <div class="grid gap-3" in:fly={{ x: 12, duration: motion(160) }}>
          <h3 class={head}>Wisp relay</h3>
          <div class={row} title="Wispr router: an HTTPS endpoint that names the relay nearest you (Spark's by default), with the others as fallbacks. Wisp server: one Wisp server, by its wss:// URL. Changing it restarts the machine.">
            <span class={lbl}><Globe size={15} />Relay</span>
            <div class="flex gap-1">
              <button type="button" class={seg(f.wispMode !== "server")} onclick={() => (f.wispMode = "router")}><LocateFixed size={13} />Wispr router</button>
              <button type="button" class={seg(f.wispMode === "server")} onclick={() => { f.wispMode = "server"; if (!f.wisp.trim()) f.wisp = located?.pick.url ?? ""; }}><Network size={13} />Wisp server</button>
            </div>
          </div>
          {#if f.wispMode === "server"}
            <div class={row} title="The Wisp server's address. Ping needs Spark's ICMP extension (0xE1); UDP needs the server's UDP extension.">
              <span class={lbl}></span>
              <input class={field} type="url" pattern="wss?://.+" required placeholder="wss://…" bind:value={f.wisp} />
              <button type="button" class={iconBtn} title="Test this server" disabled={!f.wisp.trim()} onclick={() => test(f.wisp.trim())}><Activity size={14} /></button>
            </div>
            {#if tests[f.wisp.trim()]}
              {@const r = tests[f.wisp.trim()]}
              <p class="pl-[140px] text-[11px] break-words text-muted">{#if r === "running"}testing…{:else if r?.ok}<span class="text-sakura">ok</span>{` · ${testSummary(r, true)}`}{:else if r}<span class="text-danger">{r.error}</span>{/if}</p>
            {/if}
          {:else}
            <div class={row} title="The Wispr router's URL. Empty: Spark's (wisp-anycast.sparkpowered.org/closest).">
              <span class={lbl}></span>
              <input class={field} type="url" pattern="https?://.+" placeholder={W.WISP_ROUTER} bind:value={f.wispRouter} />
              <button type="button" class={iconBtn} title="Locate with this router" disabled={locating} onclick={relocate}><Radar size={14} /></button>
            </div>
          {/if}
          <p class="flex min-w-0 flex-wrap items-center gap-x-2 pl-[140px] text-[11px] text-muted">
            {#if relay}<CircleCheck size={12} class="text-sakura" />In use: <span class="text-fg">{relay.name}</span> <code class="break-all">{relay.url}</code>{:else}The machine has not picked a relay yet.{/if}
          </p>
          {#if located?.you?.ip}
            {@const y = located.you}
            <button type="button" class="ml-[140px] flex w-fit max-w-[calc(100%-140px)] items-center gap-2 rounded-full px-3 py-1 text-left text-[11px] ring-1 ring-line hover:ring-sakura/50"
              title={reveal ? "Hide" : "Your public IP and its location, as the router sees them"} onclick={() => (reveal = !reveal)}>
              <LocateFixed size={12} class="shrink-0 text-muted" />
              <span class="text-muted">You:</span>
              <span class="break-all transition-[filter] duration-150 {reveal ? 'text-fg' : 'blur-sm select-none'}">{y.ip} · {[y.city, y.country].filter(Boolean).join(", ")}{y.latitude != null ? ` (${y.latitude.toFixed(2)}, ${y.longitude?.toFixed(2)})` : ""}</span>
              {#if !reveal}<span class="shrink-0 text-muted">click to reveal</span>{/if}
            </button>
          {/if}

          {#if f.wispMode !== "server"}
          <div class="grid gap-1.5 rounded-2xl border border-line p-3">
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <Radar size={14} class="text-muted" />
              <span class="min-w-0 flex-1 text-muted">
                {#if locating}Locating the nearest relay…
                {:else if located?.source === "router"}Nearest by your IP: <span class="text-fg">{located.pick.name}</span>
                {:else if located}Router unreachable ({located.error}); by your time zone: <span class="text-fg">{located.pick.name}</span>{/if}
              </span>
              <button type="button" class="rounded-full px-2.5 py-1 text-[11px] text-muted ring-1 ring-line hover:text-sakura" disabled={locating} onclick={relocate}>Locate</button>
              <button type="button" class="rounded-full bg-sakura/20 px-2.5 py-1 text-[11px] text-sakura hover:bg-sakura/30" disabled={!located} onclick={testAll}>Test all</button>
            </div>
            {#each located?.nodes ?? [] as n (n.url)}
              {@const r = tests[n.url]}
              <div class="flex items-start gap-2 rounded-xl px-2 py-1 text-[11px] {n.url === located?.pick.url ? 'bg-sakura/10' : ''}">
                <span class="w-24 shrink-0 truncate pt-1 text-fg" title={n.url}>{n.name}</span>
                <span class="w-16 shrink-0 pt-1 text-muted">{n.distanceKm != null ? `${Math.round(n.distanceKm)} km` : ""}{#if n.up === false} <span class="text-danger">down</span>{/if}</span>
                <span class="min-w-0 flex-1 pt-1 break-words text-muted">
                  {#if r === "running"}<LoaderCircle size={11} class="inline animate-spin" /> testing…
                  {:else if r?.ok}<span class="text-sakura">ok</span>{` · ${testSummary(r, true)}`}
                  {:else if r}<span class="text-danger">{r.error}</span>{/if}
                </span>
                <button type="button" class={iconBtn} title="Test: handshake, a TCP request, a UDP DNS query" onclick={() => test(n.url)}><Activity size={13} /></button>
              </div>
            {/each}
          </div>
          {/if}

          <h3 class={head}>Tunnels</h3>
          <p class="text-[11px] text-muted">A port of the machine reachable from the internet. This page is the tunnel's client, through the relay: nothing is installed in the machine.</p>
          <ul class="grid gap-1.5">
            {#each tunnels.list as t (t.id)}
              <li class="flex items-center gap-2 rounded-2xl border border-line bg-panel px-3 py-2 text-xs">
                <ArrowRightLeft size={14} class={t.status === "up" ? "text-sakura" : "text-muted"} />
                <span class="w-28 shrink-0 text-muted" title={t.provider === "bore" ? `bore server ${t.server}${t.secret ? " (with a secret)" : ""}` : "bore.pub"}>TCP {t.port} <span class="text-[10px]">· {t.label}</span></span>
                <span class="min-w-0 flex-1 break-words">
                  {#if t.status === "up"}
                    <span class="flex flex-wrap items-center gap-x-1.5">
                      <button type="button" class="text-fg hover:text-sakura" title="Copy" onclick={() => copy(t.address)}>{t.address}</button>
                      <span class="text-muted">·</span><span class="text-muted">{t.open} open, {t.total} total</span>
                      {#if copied === t.address}<span class="text-muted">·</span><span class="text-sakura">copied</span>{/if}
                    </span>
                  {:else if t.status === "stopped"}<span class="text-muted">stopped</span>
                  {:else}<span class="text-muted"><LoaderCircle size={11} class="inline animate-spin" /> {t.status === "retrying" ? "reconnecting" : "connecting"}…</span>{/if}
                  {#if t.error}<span class="block text-[10px] break-words text-danger">{t.error}</span>{/if}
                </span>
                <span class="relative inline-flex shrink-0">
                  <select class="appearance-none rounded-full border border-line bg-panel py-0.5 pr-6 pl-2.5 text-[10px] text-muted outline-none focus:border-blossom" title="HAProxy PROXY protocol header on each connection to the machine (for new connections)"
                    value={t.proxy} onchange={(e) => tunnels.setProxy(t, (e.currentTarget as HTMLSelectElement).value as ProxyProtocol)}>
                    {#each PROXIES as p (p.id)}<option value={p.id}>{p.label}</option>{/each}
                  </select>
                  <ChevronDown size={11} class="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-muted" />
                </span>
                {#if t.status === "stopped"}
                  <button type="button" class={iconBtn} title="Start" disabled={!booted} onclick={() => tunnels.start(t)}><Power size={13} /></button>
                {:else}
                  <button type="button" class={iconBtn} title="Stop" onclick={() => tunnels.stop(t)}><Square size={13} /></button>
                {/if}
                <button type="button" class={iconBtn} title="Remove" onclick={() => tunnels.remove(t)}><Trash2 size={13} /></button>
              </li>
            {/each}
          </ul>
          <div class="grid gap-2 rounded-2xl border border-dashed border-line p-3">
            <div class="flex flex-wrap items-center gap-1">
              <Plus size={14} class="mr-1 text-muted" />
              {#each PROVIDERS as pv (pv.id)}
                <button type="button" class={seg(tProvider === pv.id)} title={pv.note} onclick={() => (tProvider = pv.id)}>{pv.label}</button>
              {/each}
            </div>
            {#if tProvider === "playit"}
              <div class="grid gap-1.5 text-xs">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="min-w-0 flex-1 text-muted">
                    {#if playit.status === "off"}{playit.hasSecret ? "Not connected." : "Not set up: connecting claims an agent on your playit.gg account."}
                    {:else if playit.status === "claiming"}Waiting for you to approve the agent on playit.gg…
                    {:else if playit.status === "connecting"}<LoaderCircle size={11} class="inline animate-spin" /> Connecting to playit.gg…
                    {:else if playit.status === "retrying"}<LoaderCircle size={11} class="inline animate-spin" /> Reconnecting…
                    {:else}<span class="text-sakura">Connected</span> · {playit.open} open, {playit.total} total{/if}
                  </span>
                  {#if playit.status === "off"}
                    <button type="button" class="rounded-full bg-sakura/20 px-3 py-1 text-[11px] text-sakura hover:bg-sakura/30 disabled:opacity-40" disabled={!booted} onclick={() => playit.start()}>Connect</button>
                  {:else}
                    <button type="button" class="rounded-full px-3 py-1 text-[11px] text-muted ring-1 ring-line hover:text-fg" onclick={() => playit.stop()}>Disconnect</button>
                  {/if}
                  {#if playit.hasSecret}<button type="button" class="rounded-full px-3 py-1 text-[11px] text-muted ring-1 ring-line hover:text-danger" title="Disconnect and forget this agent (connecting again claims a new one)" onclick={() => playit.forget()}>Forget</button>{/if}
                </div>
                {#if playit.claimUrl}
                  <a class="w-fit rounded-full bg-sakura px-3 py-1 text-[11px] font-bold text-bar hover:brightness-110" href={playit.claimUrl} target="_blank" rel="noopener">Approve on playit.gg</a>
                {/if}
                {#if playit.error}<p class="text-[10px] break-words text-danger">{playit.error}</p>{/if}
                {#if playit.hasSecret && playit.status !== "claiming"}
                  <ul class="grid gap-1">
                    {#each playit.tunnels as pt (pt.internalId)}
                      <li class="flex flex-wrap items-center gap-x-1.5 rounded-xl border border-line bg-panel px-2.5 py-1.5 text-[11px]">
                        <span class="text-muted">{pt.proto.toUpperCase()}</span><span class="text-muted">·</span>
                        <button type="button" class="text-fg hover:text-sakura" title="Copy" onclick={() => copy(pt.address)}>{pt.address}</button>
                        <span class="text-muted">→ port {pt.localPort}{pt.portCount > 1 ? `–${pt.localPort + pt.portCount - 1}` : ""}</span>
                        {#if pt.proxy}<span class="text-muted">·</span><span class="text-muted">PROXY {pt.proxy}</span>{/if}
                        {#if pt.disabled}<span class="text-muted">·</span><span class="text-danger">{pt.disabled}</span>{/if}
                        {#if copied === pt.address}<span class="text-muted">·</span><span class="text-sakura">copied</span>{/if}
                        <span class="min-w-0 flex-1 truncate text-right text-muted">{pt.name}</span>
                      </li>
                    {:else}
                      <li class="text-[11px] text-muted">No tunnels yet.</li>
                    {/each}
                  </ul>
                  <div class="flex flex-wrap gap-2 text-[11px]">
                    <a class="text-sakura hover:underline" href={playit.agentId ? `https://playit.gg/account/agents/${playit.agentId}` : "https://playit.gg/account/tunnels"} target="_blank" rel="noopener">Add or edit tunnels on playit.gg</a>
                    <button type="button" class="text-muted hover:text-fg" onclick={() => playit.refreshTunnels().catch((e) => (playit.error = e.message))}>Refresh</button>
                  </div>
                {/if}
              </div>
            {:else if tProvider === "bore"}
              <div class="flex items-center gap-2">
                <input class={field} placeholder="bore.example.com (port 7835) or host:port" bind:value={tServer} aria-label="bore server" />
                <input class="{field} max-w-40" type="password" placeholder="secret (optional)" bind:value={tSecret} aria-label="bore secret" autocomplete="off" />
              </div>
            {/if}
            {#if tProvider !== "playit"}
            <div class="flex items-center gap-2">
              <input class={field} type="number" min="1" max="65535" placeholder="port in the machine, e.g. 8000" bind:value={tunnelPort} aria-label="Port"
                onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTunnel(); } }} />
<span class="relative inline-flex shrink-0">
                            <select class="appearance-none rounded-full border border-line bg-panel py-1.5 pr-8 pl-3.5 text-xs text-fg outline-none focus:border-blossom" bind:value={tProxy}
                title="HAProxy PROXY protocol: each connection to the machine starts with a PROXY header (nginx: listen … proxy_protocol; HAProxy: accept-proxy). bore does not tell who the visitor is, so its header has no addresses (v1 UNKNOWN, v2 LOCAL).">
                {#each PROXIES as p (p.id)}<option value={p.id}>{p.label}</option>{/each}
              </select>
              <ChevronDown size={13} class="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted" />
              </span>
              <button type="button" class="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-sakura/20 text-sakura hover:bg-sakura/30 disabled:opacity-40"
                title={booted ? "Expose this TCP port" : "Once the machine is up"} disabled={!booted || !tunnelReady} onclick={addTunnel}><Check size={15} /></button>
            </div>
            {/if}
            <p class="text-[10px] text-muted">{PROVIDERS.find((x) => x.id === tProvider)?.note}</p>
          </div>
        </div>
      {:else if tab === "terminal"}
        <div class="grid gap-3" in:fly={{ x: 12, duration: motion(160) }}>
          <div class="flex items-start gap-3">
            <span class="{lbl} pt-1.5"><Palette size={15} />Theme</span>
            <div class="grid flex-1 grid-cols-2 gap-1.5 sm:grid-cols-3">
              {#each themes as t (t.id)}
                <span class="group relative flex min-w-0">
                  <button type="button" title={t.name} onclick={() => (f.theme = t.id)}
                    class="flex min-w-0 flex-1 items-center gap-2 rounded-full border px-2 py-1 text-left text-[11px] transition-colors {f.theme === t.id ? 'border-sakura/60 bg-sakura/10 text-sakura' : 'border-line text-muted hover:text-fg'} {isUserTheme(t.id) ? 'pr-6' : ''}">
                    <span class="flex shrink-0 -space-x-1.5">
                      {#each [t.ui.bar, t.ui.bg, t.ui.sakura, t.term.green, t.term.blue] as c, i (i)}<span class="h-3.5 w-3.5 rounded-full ring-1 ring-black/30" style="background: {c}"></span>{/each}
                    </span>
                    <span class="truncate">{t.name}</span>
                  </button>
                  {#if isUserTheme(t.id)}
                    <button type="button" class="absolute top-1/2 right-1 grid h-4 w-4 -translate-y-1/2 place-items-center rounded-full text-muted opacity-0 group-hover:opacity-100 hover:text-danger" title="Delete this theme" onclick={() => removeTheme(t.id)}><X size={11} /></button>
                  {/if}
                </span>
              {/each}
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-1.5 pl-[140px] text-[11px]">
            <button type="button" class={seg(themePanel === "import")} onclick={() => { themePanel = themePanel === "import" ? "" : "import"; themeError = ""; }}><FileUp size={13} />Import</button>
            <button type="button" class={seg(themePanel === "edit")} onclick={() => (themePanel === "edit" ? (themePanel = "") : customize())}><Paintbrush size={13} />Customize</button>
            <button type="button" class={seg(false)} title="Copy the selected theme as JSON, to share it" onclick={copyTheme}><ClipboardCopy size={13} />Export</button>
            {#if themeNote}<span class="text-sakura">{themeNote}</span>{/if}
          </div>
          {#if themePanel === "import"}
            <div class="ml-[140px] grid gap-2 rounded-2xl border border-dashed border-line p-3">
              <textarea class="h-28 w-full resize-y rounded-xl border border-line bg-panel p-2 font-mono text-[11px] text-fg outline-none focus:border-blossom" bind:value={importText}
                placeholder={'Paste a theme: this app\'s JSON (from Export), or a Windows Terminal scheme, e.g.\n{ "name": "Dracula", "background": "#282a36", "foreground": "#f8f8f2", "black": "#21222c", … "brightWhite": "#ffffff" }\nSeveral: a JSON array.'}></textarea>
              <div class="flex items-center gap-2">
                <button type="button" class="rounded-full bg-sakura/20 px-3 py-1 text-[11px] text-sakura hover:bg-sakura/30 disabled:opacity-40" disabled={!importText.trim()} onclick={() => importThemes(importText)}>Add</button>
                <button type="button" class="rounded-full px-3 py-1 text-[11px] text-muted ring-1 ring-line hover:text-fg" onclick={() => themeFile?.click()}>From a file…</button>
                <input type="file" accept=".json,application/json" hidden bind:this={themeFile} onchange={importFile} />
              </div>
              {#if themeError}<p class="text-[11px] break-words text-danger">{themeError}</p>{/if}
            </div>
          {:else if themePanel === "edit" && draft}
            <div class="ml-[140px] grid gap-2 rounded-2xl border border-dashed border-line p-3 text-[11px]">
              <input class={field} bind:value={draft.name} placeholder="Theme name" aria-label="Theme name" />
              <p class="text-muted">Page</p>
              <div class="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {#each UI_LABELS as [k, label] (k)}
                  <label class="flex items-center gap-2 text-muted"><input type="color" class="h-6 w-8 shrink-0 cursor-pointer rounded border border-line bg-transparent" bind:value={draft.ui[k]} />{label}</label>
                {/each}
              </div>
              <p class="text-muted">Terminal</p>
              <div class="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                {#each TERM_KEYS as k (k)}
                  <label class="flex items-center gap-2 text-muted"><input type="color" class="h-6 w-8 shrink-0 cursor-pointer rounded border border-line bg-transparent"
                    value={(draft.term[k] ?? "#000000").slice(0, 7)} oninput={(e) => { if (draft) draft.term = { ...draft.term, [k]: (e.currentTarget as HTMLInputElement).value }; }} />{k.replace(/([A-Z])/g, " $1").toLowerCase()}</label>
                {/each}
              </div>
              <div class="flex items-center gap-2">
                <button type="button" class="rounded-full bg-sakura/20 px-3 py-1 text-sakura hover:bg-sakura/30 disabled:opacity-40" disabled={!draft.name.trim()} onclick={saveDraft}>Save as my theme</button>
                <button type="button" class="rounded-full px-3 py-1 text-muted ring-1 ring-line hover:text-fg" onclick={() => (themePanel = "")}>Cancel</button>
              </div>
              {#if themeError}<p class="break-words text-danger">{themeError}</p>{/if}
            </div>
          {/if}
          <div class={row}>
            <span class={lbl}><Type size={15} />Font size</span>
            <input class={field} type="number" min="8" max="32" required bind:value={f.fontSize} /><span class={unit}>px</span>
          </div>
          <div class={row}>
            <span class={lbl}><MoveVertical size={15} />Line height</span>
            <input class={field} type="number" min="1" max="2" step="0.02" required bind:value={f.lineHeight} /><span class={unit}></span>
          </div>
          <div class={row}>
            <span class={lbl}><TextCursor size={15} />Cursor</span>
            <div class="flex flex-1 flex-wrap gap-1">
              {#each [["bar", "▏"], ["block", "█"], ["underline", "▁"]] as [v, glyph] (v)}
                <button type="button" class={seg(f.cursorStyle === v)} title={v} onclick={() => (f.cursorStyle = v as Launch["cursorStyle"])}><span class="w-2.5 text-center">{glyph}</span>{v}</button>
              {/each}
              <button type="button" class={seg(f.cursorBlink)} title="Blink" onclick={() => (f.cursorBlink = !f.cursorBlink)}><Sparkles size={13} />blink</button>
            </div>
          </div>
          <div class={row} title="Lines kept above the screen.">
            <span class={lbl}><ScrollText size={15} />Scrollback</span>
            <input class={field} type="number" min="0" max="100000" step="1000" required bind:value={f.scrollback} /><span class={unit}>lines</span>
          </div>
          <div class={row}>
            <span class={lbl}><Combine size={15} />Ligatures</span>
            <div class="flex gap-1">
              <button type="button" class={seg(f.ligatures)} onclick={() => (f.ligatures = true)}>-&gt; =&gt; !=</button>
              <button type="button" class={seg(!f.ligatures)} onclick={() => (f.ligatures = false)}>off</button>
            </div>
          </div>
          <div class={row}>
            <span class={lbl}><Bell size={15} />Bell</span>
            <div class="flex gap-1">
              <button type="button" class={seg(f.bell === "thock")} onclick={() => (f.bell = "thock")}><Bell size={13} />thock</button>
              <button type="button" class={seg(f.bell === "off")} onclick={() => (f.bell = "off")}><BellOff size={13} />off</button>
            </div>
          </div>
        </div>
      {:else}
        <div class="grid gap-3" in:fly={{ x: 12, duration: motion(160) }}>
          <div class="flex items-center gap-2 text-[11px] text-muted" title="This site's share of the browser's storage">
            <HardDrive size={14} />
            <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-raised">
              <div class="h-full rounded-full bg-sakura/70" style="width: {usage.quota ? Math.max(1, (100 * usage.usage) / usage.quota) : 0}%"></div>
            </div>
            <span>{gb(usage.usage)} / {gb(usage.quota)}</span>
          </div>

          <ul class="grid gap-1.5">
            {#each list as r (r.id)}
              <li animate:flip={{ duration: motion(180) }} in:fade={{ duration: motion(150) }} class="flex items-center gap-3 rounded-2xl border px-3 py-2 {r.id === root.id ? 'border-sakura/40 bg-sakura/10' : 'border-line bg-panel'}">
                <span class="grid h-8 w-8 shrink-0 place-items-center rounded-full {r.id === root.id ? 'bg-sakura/20 text-sakura' : 'bg-raised text-muted'}"><DistroIcon icon={r.icon} name={r.name} size={16} /></span>
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1.5 text-[13px]">
                    <span class="truncate">{r.name}</span>
                    {#if r.note}<span class="shrink-0 rounded-full bg-raised px-2 text-[10px] text-muted">{r.note}</span>{/if}
                  </div>
                  <div class="flex items-center gap-1.5 text-[10px] text-muted">
                    {#if r.id === root.id}<span class="flex items-center gap-1 text-sakura"><CircleDot size={10} />running</span>·{/if}
                    <span title="Its disk in this browser">{r.size ? gb(r.size) : "not unpacked"}</span>
                  </div>
                </div>
                {#if r.id === root.id}
                  <button type="button" class={iconBtn} title="Save this disk (.tar.gz)" onclick={() => { open = false; onsave(); }}><Save size={14} /></button>
                  <button type="button" class={iconBtn} title="Load a saved disk" onclick={() => { open = false; onload(); }}><FolderOpen size={14} /></button>
                {:else}
                  <button type="button" class={iconBtn} title="Switch to this root" onclick={() => switchTo(r)}><Play size={14} /></button>
                {/if}
                <button type="button" class={iconBtn} title="Reset: delete its disk" disabled={!r.size && r.id !== root.id} onclick={() => resetRoot(r)}><RotateCcw size={14} /></button>
                <button type="button" class={iconBtn} title={r.builtin ? "Built in" : "Delete"} disabled={r.builtin || r.id === root.id} onclick={() => deleteRoot(r)}><Trash2 size={14} /></button>
              </li>
            {/each}
          </ul>

          <div class="grid gap-2 rounded-2xl border border-dashed border-line p-3">
            <div class="flex items-center gap-1">
              <Plus size={14} class="mr-1 text-muted" />
              <button type="button" class={seg(addKind === "docker")} title="Any image from Docker Hub, built into a root by the server" onclick={() => (addKind = "docker")}><Container size={13} />Docker</button>
              <button type="button" class={seg(addKind === "url")} title="A .tar.gz of a root filesystem on the web (it must allow CORS)" onclick={() => (addKind = "url")}><Link size={13} />URL</button>
              <button type="button" class={seg(addKind === "file")} title="A .tar.gz of a root filesystem from this computer" onclick={() => (addKind = "file")}><FileArchive size={13} />File</button>
            </div>
            <div class="flex items-center gap-2">
              {#if addKind === "file"}
                <button type="button" class="flex flex-1 items-center justify-center gap-2 rounded-full border border-line bg-panel px-3 py-1.5 text-xs text-muted hover:border-blossom hover:text-fg"
                  disabled={!!adding} onclick={() => fileInput?.click()}><Upload size={14} />.tar.gz</button>
              {:else}
                <input class={field} bind:value={addValue} disabled={!!adding}
                  placeholder={addKind === "docker" ? "alpine:3.22, fedora:42, archlinux…" : "https://…/rootfs.tar.gz"}
                  onkeydown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } }} />
                <button type="button" class="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-sakura/20 text-sakura hover:bg-sakura/30 disabled:opacity-40"
                  title="Add" disabled={!!adding || !addValue.trim()} onclick={add}>
                  {#if adding}<LoaderCircle size={15} class="animate-spin" />{:else}<Check size={15} />{/if}
                </button>
              {/if}
            </div>
            {#if adding}<p class="flex items-center gap-1.5 text-[11px] text-sakura"><LoaderCircle size={12} class="animate-spin" />{adding}…</p>{/if}
            {#if addError}<p class="text-[11px] text-danger">{addError}</p>{/if}
            <input type="file" accept=".gz,.tgz,application/gzip" hidden bind:this={fileInput} onchange={addFile} />
          </div>
        </div>
      {/if}
    </div>

    {#if tab !== "storage"}
      <footer class="flex items-center gap-2 border-t border-line bg-bar px-4 py-2.5">
        <button type="button" class="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs text-muted hover:bg-raised hover:text-fg" title="Back to the defaults"
          onclick={() => (f = { ...DEFAULTS })}><RotateCcw size={13} />Defaults</button>
        <span class="flex-1"></span>
        <button type="submit" class="flex items-center gap-1.5 rounded-full bg-sakura px-4 py-1.5 text-xs font-bold text-bar hover:brightness-110"
          title={tab === "nanite" || tab === "network" ? "Saves; a changed relay or Nanite setting restarts the machine (the disk stays)" : "Applies at once"}>
          {#if (tab === "nanite" || tab === "network") && needsRestart(current, f)}<RotateCcw size={13} />Restart{:else}<Check size={13} />Apply{/if}
        </button>
      </footer>
    {/if}
  </form>
</dialog>
