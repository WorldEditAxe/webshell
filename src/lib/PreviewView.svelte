<!-- A Preview tab: a small browser, on Scramjet (lib/preview.ts): web servers inside the machine (a dev server,
     python3 -m http.server, ...) at localhost:PORT, and web sites through the machine's Wisp relay. Back, forward, reload, an
     address bar that takes "3000", "localhost:5173/app", "/path" (on the current site) or a web address, zoom, and devtools in
     a sidebar. -->
<script lang="ts">
  import { onDestroy } from "svelte";
  import { ArrowLeft, ArrowRight, RotateCw, X, Globe, ExternalLink, LoaderCircle, Wrench, ChevronDown, Check, ZoomIn, ZoomOut } from "@lucide/svelte";
  import CertViewer from "./CertViewer.svelte";
  import { proxy, previewSupported, attachDevtools, DEVTOOLS, ERUDA_DOC, type Devtools } from "./preview";

  let { active, ontitle }: { active: boolean; ontitle: (title: string) => void } = $props();

  const PORTS = [3000, 5173, 8000, 8080];
  /** The real URL shown ("" before the first). */
  let url = $state(""), addr = $state(""), editing = $state(false), loading = $state(false), bad = $state(""), failed = $state("");
  let frame = $state<HTMLIFrameElement>(), input = $state<HTMLInputElement>();
  let sj: Awaited<ReturnType<Awaited<ReturnType<typeof proxy>>["createFrame"]>> | null = null;

  // Devtools: the one chosen the first time (asked then; the menu beside the button changes it), as a sidebar beside the page.
  const DT_KEY = "nanite-preview-devtools", W_KEY = "nanite-preview-devtools-width";
  const load = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
  const store = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch {} };
  const saved = load(DT_KEY);
  let backend = $state<Devtools | null>(saved && saved in DEVTOOLS ? (saved as Devtools) : null);
  let devtools = $state(false), asking = $state(false), dtMenu = $state(false), dragging = $state(false);
  let width = $state(Math.max(280, +(load(W_KEY) ?? 0) || 420));
  let side = $state<HTMLIFrameElement>(), body = $state<HTMLDivElement>();

  /** The devtools go into the page as it loads: show them, then load the page again. */
  function setDevtools(on: boolean, mode = backend): void {
    if (on && !mode) { asking = true; return; }
    asking = false; dtMenu = false;
    const changed = on !== devtools || mode !== backend;
    devtools = on; backend = mode;
    if (mode) store(DT_KEY, mode);
    if (changed && url) setTimeout(reload, 50);   // after the sidebar's frame exists
  }
  function choose(mode: Devtools): void { setDevtools(true, mode); }
  function forget(): void { store(DT_KEY, null); backend = null; dtMenu = false; if (devtools) setDevtools(false, null); }

  function startDrag(e: PointerEvent): void {
    e.preventDefault(); dragging = true;
    const move = (m: PointerEvent) => {
      const r = body!.getBoundingClientRect();
      width = Math.round(Math.min(Math.max(280, r.right - m.clientX), r.width - 160));
    };
    const up = () => { dragging = false; store(W_KEY, String(width)); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", up);
  }

  const LOCAL = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.0\.2\.15)$/i;
  /** The address bar's text for a URL: the machine's pages as localhost:PORT/path, the web's as they are. */
  function shown(u: string): string {
    try { const x = new URL(u); return LOCAL.test(x.hostname) && x.protocol === "http:" ? `${x.host}${x.pathname}${x.search}${x.hash}` : u; } catch { return u; }
  }
  /** "3000", ":3000/x", "localhost:3000/x", "/x" (on the current site), "example.com", "https://example.com/x" -> a URL. */
  function parse(text: string): string | null {
    const t = text.trim();
    if (!t) return null;
    if (t.startsWith("/")) return url ? new URL(t, url).href : null;
    const port = /^:?(\d{1,5})(\/.*)?$/.exec(t);
    if (port) return +port[1]! > 0 && +port[1]! < 65536 ? `http://localhost:${port[1]}${port[2] ?? "/"}` : null;
    if (/^[a-z][\w+.-]*:\/\//i.test(t)) { try { const u = new URL(t); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; } }
    const host = /^([^/:?#]+)(:\d{1,5})?([/?#].*)?$/.exec(t);
    if (!host) return null;
    if (LOCAL.test(host[1]!)) return `http://${t}`;
    if (!host[1]!.includes(".")) return null;
    return `https://${t}`;
  }
  async function go(to: string): Promise<void> {
    bad = ""; failed = ""; loading = true; url = to; addr = shown(to);
    try {
      const c = await proxy();
      await new Promise((r) => requestAnimationFrame(r));   // the frame element exists once url is set
      if (!sj && frame) {
        sj = c.createFrame(frame);
        sj.addEventListener("urlchange", (e) => { url = e.url; if (!editing) addr = shown(e.url); });
      }
      sj?.go(to);
    } catch (e) {
      loading = false; failed = (e as Error)?.message ?? String(e);
    }
  }
  function submit(e: SubmitEvent): void {
    e.preventDefault();
    const to = parse(addr);
    if (!to) { bad = "Type a port (3000), localhost:PORT/path, a web address, or /path"; return; }
    input?.blur(); void go(to);
  }
  const win = () => { try { return frame?.contentWindow ?? null; } catch { return null; } };
  function back(): void { sj?.back(); }
  function forward(): void { sj?.forward(); }
  function reload(): void { if (!sj) { if (url) void go(url); return; } loading = true; sj.reload(); }
  function openOutside(): void { if (url) window.open(url, "_blank", "noopener"); }
  function stopOrReload(): void { if (loading) { win()?.stop(); loading = false; } else reload(); }

  /** What the frame shows now: the tab title follows it. */
  function sync(): void {
    let title = "";
    try { title = win()?.document.title ?? ""; } catch {}
    let fallback = "Web Browser";
    try { if (url) fallback = shown(url).replace(/\/$/, ""); } catch {}
    ontitle(title || fallback);
  }
  function loaded(): void {
    loading = false; sync(); hookKeys();
    if (devtools && backend && frame && side) attachDevtools(frame, side, backend);
  }
  $effect(() => {
    if (!active || !url) return;
    const t = setInterval(sync, 700);
    return () => clearInterval(t);
  });
  $effect(() => { if (active && !url) requestAnimationFrame(() => input?.focus()); });
  onDestroy(() => { sj = null; });

  // Zoom: the frame is drawn larger or smaller (scaled, with its viewport resized to match, like a browser's zoom); the page is
  // not touched. Ctrl/Cmd with + - 0 in the page or the toolbar, or the menu. Remembered for all Preview tabs.
  const Z_KEY = "nanite-preview-zoom", STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
  let zoom = $state(STEPS.includes(+(load(Z_KEY) ?? 1)) ? +(load(Z_KEY) ?? 1) : 1), zoomMenu = $state(false);
  const pct = (z: number) => `${Math.round(z * 100)}%`;
  function setZoom(z: number): void { zoom = z; store(Z_KEY, String(z)); }
  function zoomBy(dir: 1 | -1): void {
    const i = STEPS.indexOf(zoom);
    setZoom(STEPS[Math.min(STEPS.length - 1, Math.max(0, (i < 0 ? STEPS.indexOf(1) : i) + dir))]!);
  }
  function zoomKey(e: KeyboardEvent): void {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    if (e.key === "=" || e.key === "+") { e.preventDefault(); zoomBy(1); }
    else if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomBy(-1); }
    else if (e.key === "0") { e.preventDefault(); setZoom(1); }
  }
  /** The page's own keys: Ctrl + - 0 zoom the preview, not the webshell. */
  function hookKeys(): void { try { win()?.addEventListener("keydown", zoomKey, true); } catch {} }

  // Menus close on a click elsewhere (the page's clicks do not reach here: they blur this window instead).
  $effect(() => {
    if (!dtMenu && !asking && !zoomMenu) return;
    const close = (e: Event) => { if (e.type === "blur" || !(e.target as Element).closest?.("[data-dtmenu],[data-zoommenu]")) { dtMenu = false; asking = false; zoomMenu = false; } };
    window.addEventListener("pointerdown", close, true); window.addEventListener("blur", close);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("blur", close); };
  });

  const btn = "grid h-7 w-7 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-sakura/15 hover:text-sakura disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted";
</script>

<div class="absolute inset-0 flex flex-col bg-bg" class:invisible={!active} role="tabpanel" tabindex="-1" onkeydown={zoomKey}>
  <form class="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-panel px-2" onsubmit={submit}>
    <button type="button" class={btn} title="Back" disabled={!url} onclick={back}><ArrowLeft size={15} /></button>
    <button type="button" class={btn} title="Forward" disabled={!url} onclick={forward}><ArrowRight size={15} /></button>
    <button type="button" class={btn} title={loading ? "Stop" : "Reload"} disabled={!url} onclick={stopOrReload}>
      {#if loading}<X size={15} />{:else}<RotateCw size={14} />{/if}
    </button>
    <label class="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-full border px-3 text-xs transition-colors
      {bad ? 'border-danger/70' : 'border-line focus-within:border-sakura/60'} bg-bg">
      {#if loading}<LoaderCircle size={13} class="shrink-0 animate-spin text-sakura" />{:else if url}<CertViewer {url} />{:else}<Globe size={13} class="shrink-0 text-muted" />{/if}
      <input bind:this={input} bind:value={addr} class="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-muted"
        placeholder="localhost:3000 or a web address" spellcheck="false" autocomplete="off" aria-label="Address" title={bad || "A port in the machine (3000, localhost:3000/path) or a web address"}
        onfocus={() => { editing = true; input?.select(); }} onblur={() => { editing = false; if (!bad) addr = shown(url); }}
        oninput={() => (bad = "")} onkeydown={(e) => { if (e.key === "Escape") { bad = ""; addr = shown(url); input?.blur(); } }} />
    </label>
    <button type="button" class={btn} title="Open the address in a browser tab (web addresses only work there; localhost ones are the machine's)" disabled={!url} onclick={openOutside}><ExternalLink size={14} /></button>
    <div class="relative flex shrink-0 items-center" data-zoommenu>
      <button type="button" class="flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-xs transition-colors hover:bg-sakura/15 hover:text-sakura {zoom !== 1 ? 'text-sakura' : 'text-muted'}"
        title="Zoom (Ctrl + / Ctrl − / Ctrl 0)" aria-haspopup="menu" aria-expanded={zoomMenu} onclick={() => { zoomMenu = !zoomMenu; dtMenu = false; asking = false; }}>
        {#if zoom < 1}<ZoomOut size={14} />{:else}<ZoomIn size={14} />{/if}{#if zoom !== 1}<span class="tabular-nums">{pct(zoom)}</span>{/if}
      </button>
      {#if zoomMenu}
        <div role="menu" class="absolute top-full right-0 z-20 mt-2 w-52 rounded-3xl border border-line bg-panel p-1.5 text-xs shadow-xl shadow-black/50">
          <div class="flex items-center gap-1 px-1 py-0.5">
            <button type="button" class={btn} title="Zoom out (Ctrl −)" disabled={zoom === STEPS[0]} onclick={() => zoomBy(-1)}><ZoomOut size={14} /></button>
            <span class="flex-1 text-center text-sm text-fg tabular-nums">{pct(zoom)}</span>
            <button type="button" class={btn} title="Zoom in (Ctrl +)" disabled={zoom === STEPS.at(-1)} onclick={() => zoomBy(1)}><ZoomIn size={14} /></button>
          </div>
          <div class="mx-3 my-1 border-t border-line"></div>
          <div class="grid grid-cols-4 gap-1 px-1 pb-1">
            {#each [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2] as z (z)}
              <button type="button" role="menuitemradio" aria-checked={zoom === z}
                class="rounded-full py-1 tabular-nums transition-colors {zoom === z ? 'bg-sakura/20 text-sakura' : 'text-fg hover:bg-sakura/15 hover:text-sakura'}" onclick={() => setZoom(z)}>{pct(z)}</button>
            {/each}
          </div>
          <button type="button" role="menuitem" class="flex w-full items-center justify-center rounded-full px-3 py-1.5 text-muted hover:bg-sakura/15 hover:text-sakura disabled:opacity-40" disabled={zoom === 1} onclick={() => setZoom(1)}>Reset to 100%</button>
        </div>
      {/if}
    </div>
    <div class="relative flex shrink-0 items-center" data-dtmenu>
      <button type="button" class="{btn} {devtools ? '!bg-sakura/20 !text-sakura' : ''}" aria-pressed={devtools}
        title={devtools ? "Hide the devtools" : backend ? `Devtools (${DEVTOOLS[backend]}): reloads the page with them` : "Devtools"}
        onclick={() => setDevtools(!devtools)}><Wrench size={14} /></button>
      <button type="button" class="grid h-7 w-4 place-items-center rounded-full transition-colors hover:text-sakura {asking ? 'bg-sakura/20 text-sakura ring-1 ring-sakura/60' : 'text-muted'}" title="Which devtools" aria-haspopup="menu" aria-expanded={dtMenu || asking}
        onclick={() => { dtMenu = !(dtMenu || asking); asking = false; zoomMenu = false; }}><ChevronDown size={12} /></button>
      {#if dtMenu || asking}
        <div role="menu" class="absolute top-full right-0 z-20 mt-2.5 w-64 rounded-3xl border bg-panel p-1.5 text-xs shadow-xl shadow-black/50 {asking ? 'border-sakura/60' : 'border-line'}">
          {#if asking}
            <!-- A callout: its pointer is on the ⌄, where the choice is changed later. -->
            <span class="absolute -top-[7px] right-[3px] h-3 w-3 rotate-45 border-t border-l border-sakura/60 bg-panel" aria-hidden="true"></span>
            <p class="px-3 pt-1.5 pb-1 text-fg">Pick your devtools.</p>
            <p class="px-3 pb-1.5 text-muted">You can switch any time from this <ChevronDown size={11} class="inline -mt-0.5 text-sakura" /> menu.</p>
          {/if}
          {#each Object.entries(DEVTOOLS) as [id, label] (id)}
            <button type="button" role="menuitemradio" aria-checked={backend === id}
              class="flex w-full items-center gap-2.5 rounded-full px-3 py-1.5 text-left text-fg hover:bg-sakura/15 hover:text-sakura" onclick={() => choose(id as Devtools)}>
              <Check size={13} class={backend === id ? "text-sakura" : "invisible"} />{label}
              <span class="ml-auto text-[10px] text-muted">{id === "eruda" ? "light, mobile-style" : "Chii, full"}</span>
            </button>
          {/each}
          {#if backend && !asking}
            <div class="mx-3 my-1 border-t border-line"></div>
            <button type="button" role="menuitem" class="flex w-full items-center gap-2.5 rounded-full px-3 py-1.5 text-left text-muted hover:bg-sakura/15 hover:text-sakura" onclick={forget}>
              <span class="w-[13px]"></span>Ask next time</button>
          {/if}
        </div>
      {/if}
    </div>
  </form>

  <div bind:this={body} class="relative flex min-h-0 flex-1">
  <div class="relative min-w-0 flex-1 overflow-hidden">
    {#if !previewSupported()}
      <div class="grid h-full place-items-center p-6 text-center text-xs text-muted">Previews need the service worker, which Vite's dev server does not run: use the built page (npm run build, npm start).</div>
    {:else if failed}
      <div class="grid h-full place-items-center p-6 text-center text-xs text-danger">The Web Browser could not start: {failed}</div>
    {:else if url}
      <!-- Scramjet's frame (same origin: its service worker serves it). -->
      <!-- color-scheme: light: the webshell's "dark" would otherwise carry into the frame, and a page without colours of its own
           (python3 -m http.server's listing) would get white text on the frame's white. -->
      <iframe bind:this={frame} title="Web Browser" class="absolute top-0 left-0 border-0 bg-white {dragging ? 'pointer-events-none' : ''}" onload={loaded}
        style="color-scheme: light; width: {100 / zoom}%; height: {100 / zoom}%; transform: scale({zoom}); transform-origin: 0 0"
        allow="clipboard-read; clipboard-write; fullscreen"></iframe>
    {:else}
      <div class="grid h-full place-items-center p-6">
        <div class="grid max-w-sm justify-items-center gap-3 text-center text-xs text-muted">
          <Globe size={28} class="text-sakura" />
          <p class="text-sm text-fg">Browse the web, or a web server in the machine</p>
          <p>Type a port or a web address above, or pick a port:</p>
          <div class="flex flex-wrap justify-center gap-1.5">
            {#each PORTS as p (p)}
              <button type="button" class="rounded-full border border-line px-3 py-1 text-fg transition-colors hover:border-sakura/60 hover:bg-sakura/15 hover:text-sakura" onclick={() => go(`http://localhost:${p}/`)}>{p}</button>
            {/each}
          </div>
          <p>Nothing running yet? In a terminal: <code class="rounded bg-raised px-1.5 py-0.5 text-sakura">python3 -m http.server 8000</code></p>
        </div>
      </div>
    {/if}
    {#if bad}<p class="absolute top-2 left-1/2 -translate-x-1/2 rounded-full border border-danger/50 bg-panel px-3 py-1 text-xs text-danger shadow-lg shadow-black/40">{bad}</p>{/if}
  </div>
  {#if devtools && backend}
    <!-- The devtools sidebar; its left edge resizes it. -->
    <div class="relative flex shrink-0 border-l border-line bg-panel" style="width: {width}px">
      <div class="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-sakura/30 {dragging ? 'bg-sakura/40' : ''}" role="separator" aria-orientation="vertical" aria-label="Resize the devtools" onpointerdown={startDrag}></div>
      <!-- Its own document, so the devtools' styles stay out of both the page and the webshell. -->
      {#key backend}
        {#if backend === "chii"}
          <iframe bind:this={side} title="Chrome DevTools" class="h-full w-full border-0 {dragging ? 'pointer-events-none' : ''}"></iframe>
        {:else}
          <iframe bind:this={side} title="Eruda" srcdoc={ERUDA_DOC} class="h-full w-full border-0 {dragging ? 'pointer-events-none' : ''}"></iframe>
        {/if}
      {/key}
      {#if !url}<p class="absolute inset-0 grid place-items-center p-4 text-center text-xs text-muted">Open a page to inspect it.</p>{/if}
    </div>
  {/if}
  </div>
</div>
