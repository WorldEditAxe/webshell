<!-- Settings, in tabs: Nanite (the emulator's launch parameters: saving restarts the machine, the disk stays), Terminal (theme
     and terminal options: they apply at once), Storage (the root filesystems: switch, add from a Docker image / URL / file,
     reset, delete). Short labels and icons; the explanations are in the tooltips. -->
<script lang="ts">
  import {
    X, Cpu, SquareTerminal, HardDrive, MemoryStick, Database, Monitor, Globe, Package, Type, MoveVertical, TextCursor, ScrollText,
    Bell, BellOff, Combine, Sparkles, Orbit, Shell, Mountain, Container, FileArchive, Link, Play, RotateCcw, Trash2, Upload, Plus,
    LoaderCircle, Check, Save, FolderOpen, CircleDot, Palette, Mouse, Move, MousePointer2,
  } from "@lucide/svelte";
  import { DEFAULTS, fromUrl, needsRestart, type Launch } from "./settings";
  import { fade, fly } from "svelte/transition";
  import { flip } from "svelte/animate";
  import { motion } from "./motion";
  import { THEMES } from "./themes";
  import * as roots from "./roots";
  import { ask } from "./ask.svelte";
  import * as M from "./machine";

  type Tab = "nanite" | "terminal" | "storage";
  let { open = $bindable(false), tab = $bindable<Tab>("nanite"), current, root, onapply, onswitch, onresetcurrent, onsave, onload }: {
    open: boolean; tab?: Tab; current: Launch; root: roots.Root;
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
      memory: num(f.memory) ?? DEFAULTS.memory, processMemory: num(f.processMemory), dcache: num(f.dcache),
      ...(w && h ? { screenWidth: w, screenHeight: h } : { screenWidth: null, screenHeight: null }),
      wisp: f.wisp.trim(), pkg: (f.pkg.trim() || DEFAULTS.pkg).replace(/\/$/, ""),
      fontSize: num(f.fontSize) ?? DEFAULTS.fontSize, lineHeight: num(f.lineHeight) ?? DEFAULTS.lineHeight, scrollback: num(f.scrollback) ?? DEFAULTS.scrollback,
    });
    open = false;
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
    { id: "nanite", label: "Nanite", icon: Cpu }, { id: "terminal", label: "Terminal", icon: SquareTerminal }, { id: "storage", label: "Storage", icon: HardDrive },
  ];
  const ROOT_ICONS: Record<string, typeof Cpu> = { ubuntu: Orbit, debian: Shell, alpine: Mountain, docker: Container, file: FileArchive, link: Link };
  const field = "w-full min-w-0 rounded-full border border-line bg-panel px-3.5 py-1.5 text-[13px] text-fg placeholder:text-muted/60 outline-none focus:border-blossom";
  const row = "flex items-center gap-3";
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
          <div class={row} title="The whole machine: kernel, every process (about 53 MiB each), caches. apt needs 512.">
            <span class={lbl}><MemoryStick size={15} />Memory</span>
            <input class={field} type="number" min="128" step="64" required bind:value={f.memory} /><span class={unit}>MiB</span>
          </div>
          <div class={row} title="One program's memory cap. Empty: min(memory, 256).">
            <span class={lbl}><Cpu size={15} />Per process</span>
            <input class={field} type="number" min="32" step="32" placeholder="auto" bind:value={f.processMemory} /><span class={unit}>MiB</span>
          </div>
          <div class={row} title="The disk's file metadata kept in the kernel's memory. Empty: Nanite's default (16); 0: no bound.">
            <span class={lbl}><Database size={15} />Metadata</span>
            <input class={field} type="number" min="0" step="4" placeholder="16" bind:value={f.dcache} /><span class={unit}>MiB</span>
          </div>
          <div class={row} title="The monitor's /dev/fb0. Empty: the monitor tab's size at start.">
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
          <div class={row} title="The guest's network. Empty: the nearest Spark relay (/closest). Ping needs Spark's 0xE1 extension.">
            <span class={lbl}><Globe size={15} />Wisp</span>
            <input class={field} type="url" pattern="wss?://.+" placeholder="auto" bind:value={f.wisp} /><span class={unit}></span>
          </div>
          <div class={row} title="Nanite is loaded from <host>/lib/nanitevisor/.">
            <span class={lbl}><Package size={15} />Package host</span>
            <input class={field} type="url" required bind:value={f.pkg} /><span class={unit}></span>
          </div>
          {#if fromUrlNote}<p class="flex items-center gap-2 text-[11px] text-muted" title="Set in the page's URL: these win over what is saved here"><Link size={13} class="text-sakura" /><code class="text-sakura">{fromUrlNote}</code></p>{/if}
        </div>
      {:else if tab === "terminal"}
        <div class="grid gap-3" in:fly={{ x: 12, duration: motion(160) }}>
          <div class="flex items-start gap-3">
            <span class="{lbl} pt-1.5"><Palette size={15} />Theme</span>
            <div class="grid flex-1 grid-cols-2 gap-1.5 sm:grid-cols-3">
              {#each THEMES as t (t.id)}
                <button type="button" title={t.name} onclick={() => (f.theme = t.id)}
                  class="flex items-center gap-2 rounded-full border px-2 py-1 text-left text-[11px] transition-colors {f.theme === t.id ? 'border-sakura/60 bg-sakura/10 text-sakura' : 'border-line text-muted hover:text-fg'}">
                  <span class="flex shrink-0 -space-x-1.5">
                    {#each [t.ui.bar, t.ui.bg, t.ui.sakura, t.term.green, t.term.blue] as c, i (i)}<span class="h-3.5 w-3.5 rounded-full ring-1 ring-black/30" style="background: {c}"></span>{/each}
                  </span>
                  <span class="truncate">{t.name}</span>
                </button>
              {/each}
            </div>
          </div>
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
              {@const Icon = ROOT_ICONS[r.icon] ?? CircleDot}
              <li animate:flip={{ duration: motion(180) }} in:fade={{ duration: motion(150) }} class="flex items-center gap-3 rounded-2xl border px-3 py-2 {r.id === root.id ? 'border-sakura/40 bg-sakura/10' : 'border-line bg-panel'}">
                <span class="grid h-8 w-8 shrink-0 place-items-center rounded-full {r.id === root.id ? 'bg-sakura/20 text-sakura' : 'bg-raised text-muted'}"><Icon size={16} /></span>
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
          title={tab === "nanite" ? "Saves and restarts the machine (the disk stays)" : "Applies at once"}>
          {#if tab === "nanite" && needsRestart(current, f)}<RotateCcw size={13} />Restart{:else}<Check size={13} />Apply{/if}
        </button>
      </footer>
    {/if}
  </form>
</dialog>
