<!-- The monitor: Nanite's /dev/fb0 (BGRX) on a canvas filling the tab, with /dev/input/event0 (keyboard) and event1 (mouse) fed
     from it. Mouse, by the setting: relative (click captures the pointer: pointer lock, relative motion like a real mouse; Esc
     releases) or absolute (the guest's cursor follows the pointer: it is sent to the corner once, then moved by the difference
     to where you point; best with the guest's pointer acceleration off). Keys go to the guest while the canvas has focus. The
     status sits in a small overlay at the top right, shown on hover. -->
<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { Keyboard, Lock, MousePointer2, Move, Maximize } from "@lucide/svelte";
  import type { Nanite } from "./machine";

  let { nv, active, screen, mouse = "relative", follow = true, onfit, ondraw }: {
    nv: Nanite | null; active: boolean; screen: { width: number; height: number }; mouse?: "relative" | "absolute";
    /** The screen follows the tab's size (Nanite's resizeScreen), unless the settings fix its size. */
    follow?: boolean; onfit: () => void; ondraw?: () => void;
  } = $props();
  let canvas: HTMLCanvasElement, area: HTMLDivElement;
  let ctx: CanvasRenderingContext2D | null = null;
  let last: { w: number; h: number; pixels: Uint8ClampedArray } | null = null, queued = false, drawn = false;
  let size = $state(""), locked = $state(false), focused = $state(false);
  let areaW = $state(0), areaH = $state(0);

  /** The canvas's area in CSS pixels, rounded down to multiples of 8: the screen size that fills the tab. */
  export function areaSize(): { width: number; height: number } {
    const r = area.getBoundingClientRect();
    return { width: Math.max(320, Math.floor(r.width / 8) * 8), height: Math.max(200, Math.floor(r.height / 8) * 8) };
  }
  const fitW = $derived(Math.floor(areaW / 8) * 8), fitH = $derived(Math.floor(areaH / 8) * 8);
  // Nanite's resizeScreen: the guest's display connector offers the tab's size as its preferred mode, as a monitor whose
  // resolution changed (a desktop on /dev/dri/card0 takes it; see ~/screen/install-desktop.sh). Sent once the size settles.
  const live = $derived(!!nv && typeof nv.resizeScreen === "function");
  let sent = "", settle = 0;
  $effect(() => {
    const w = fitW, h = fitH, m = nv;
    if (!follow || !live || !m || w < 320 || h < 200) return;
    clearTimeout(settle);
    settle = window.setTimeout(() => {
      if (`${w}x${h}` === sent) return;
      sent = `${w}x${h}`;
      try { m.resizeScreen!(w, h, 1); } catch (e) { console.warn("resizeScreen:", e); }
    }, 150);
  });
  $effect(() => { void nv; sent = ""; });
  // Without resizeScreen (an older Nanite), or with the size fixed in the settings: offer a restart at the tab's size.
  const stale = $derived(!(follow && live) && screen.width > 0 && areaW > 0 && (Math.abs(fitW - screen.width) >= 16 || Math.abs(fitH - screen.height) >= 16));

  /** A frame from the machine (painted at the next animation frame, while this tab is shown). The first one with anything on
   *  it is reported (ondraw), so the page can point at a closed monitor. */
  export function frame(w: number, h: number, pixels: Uint8ClampedArray): void {
    last = { w, h, pixels };
    if (!drawn) {
      for (let i = 0; i < pixels.length; i += 4 * 97) if (pixels[i] || pixels[i + 1] || pixels[i + 2]) { drawn = true; ondraw?.(); break; }
    }
    if (!queued && active) { queued = true; requestAnimationFrame(paint); }
  }
  function paint(): void {
    queued = false; if (!last || !ctx) return;
    const { w, h, pixels } = last;
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    size = `${w}×${h}`;
    ctx.putImageData(new ImageData(pixels as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0);
  }

  // KeyboardEvent.code -> Linux input key code (linux/input-event-codes.h).
  const KEYCODES: Record<string, number> = {};
  "Escape Digit1 Digit2 Digit3 Digit4 Digit5 Digit6 Digit7 Digit8 Digit9 Digit0 Minus Equal Backspace Tab KeyQ KeyW KeyE KeyR KeyT KeyY KeyU KeyI KeyO KeyP BracketLeft BracketRight Enter ControlLeft KeyA KeyS KeyD KeyF KeyG KeyH KeyJ KeyK KeyL Semicolon Quote Backquote ShiftLeft Backslash KeyZ KeyX KeyC KeyV KeyB KeyN KeyM Comma Period Slash ShiftRight NumpadMultiply AltLeft Space CapsLock F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 NumLock ScrollLock Numpad7 Numpad8 Numpad9 NumpadSubtract Numpad4 Numpad5 Numpad6 NumpadAdd Numpad1 Numpad2 Numpad3 Numpad0 NumpadDecimal"
    .split(" ").forEach((c, i) => { KEYCODES[c] = i + 1; });
  Object.assign(KEYCODES, { IntlBackslash: 86, F11: 87, F12: 88, NumpadEnter: 96, ControlRight: 97, NumpadDivide: 98, PrintScreen: 99, AltRight: 100,
    Home: 102, ArrowUp: 103, PageUp: 104, ArrowLeft: 105, ArrowRight: 106, End: 107, ArrowDown: 108, PageDown: 109, Insert: 110, Delete: 111,
    Pause: 119, MetaLeft: 125, MetaRight: 126, ContextMenu: 127 });
  const BUTTONS = [272, 274, 273]; // BTN_LEFT, BTN_MIDDLE, BTN_RIGHT, by MouseEvent.button
  const held = new Set<number>();
  const releaseKeys = () => { for (const k of held) nv?.key(k, false); held.clear(); };

  function key(e: KeyboardEvent, down: boolean): void {
    const k = KEYCODES[e.code]; if (k === undefined || !nv) return;
    e.preventDefault(); e.stopPropagation();
    if (down) held.add(k); else held.delete(k);
    nv.key(k, down);
  }

  // Where the screen is drawn in the canvas box (object-contain: scaled to fit, centred).
  function box(): { x: number; y: number; s: number } {
    const s = Math.min(canvas.clientWidth / canvas.width, canvas.clientHeight / canvas.height);
    return { x: (canvas.clientWidth - canvas.width * s) / 2, y: (canvas.clientHeight - canvas.height * s) / 2, s };
  }
  // Absolute mode: where the guest's cursor is (null: not known; it is sent to the corner first).
  let guest: { x: number; y: number } | null = null;
  function pointAt(e: MouseEvent): void {
    if (!nv) return;
    const b = box(), r = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(canvas.width - 1, Math.round((e.clientX - r.left - b.x) / b.s)));
    const y = Math.max(0, Math.min(canvas.height - 1, Math.round((e.clientY - r.top - b.y) / b.s)));
    if (!guest) { nv.mouse({ dx: -4 * canvas.width, dy: -4 * canvas.height }); guest = { x: 0, y: 0 }; }
    const dx = x - guest.x, dy = y - guest.y;
    if (dx || dy) { nv.mouse({ dx, dy }); guest = { x, y }; }
  }

  function mousedown(e: MouseEvent): void {
    e.preventDefault(); canvas.focus();
    if (mouse === "relative" && document.pointerLockElement !== canvas) { (canvas.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => {}); return; }
    if (mouse === "absolute") pointAt(e);
    if (BUTTONS[e.button] && nv) nv.mouse({ button: BUTTONS[e.button], down: true });
  }
  function mouseup(e: MouseEvent): void {
    if ((mouse === "absolute" || document.pointerLockElement === canvas) && BUTTONS[e.button] && nv) nv.mouse({ button: BUTTONS[e.button], down: false });
  }
  // Fast strokes: every sample the browser coalesced into this event is sent (getCoalescedEvents), so the guest gets the whole
  // path, not one point per frame. Relative motion keeps its sub-pixel remainder, so nothing is lost to rounding.
  let restX = 0, restY = 0;
  function mousemove(e: PointerEvent): void {
    if (!nv) return;
    const samples = e.getCoalescedEvents?.() ?? [];
    const list: PointerEvent[] = samples.length ? samples : [e];
    if (mouse === "absolute") { for (const p of list) pointAt(p); return; }
    if (document.pointerLockElement !== canvas) return;
    // Scale so the guest's cursor follows the hand at the screen's displayed size.
    const s = 1 / box().s;
    for (const p of list) {
      restX += p.movementX * s; restY += p.movementY * s;
      const dx = Math.trunc(restX), dy = Math.trunc(restY);
      if (dx || dy) { nv.mouse({ dx, dy }); restX -= dx; restY -= dy; }
    }
  }

  onMount(() => {
    ctx = canvas.getContext("2d");
    const ro = new ResizeObserver(() => { areaW = area.clientWidth; areaH = area.clientHeight; });
    ro.observe(area);
    const onLock = () => { locked = document.pointerLockElement === canvas; };
    document.addEventListener("pointerlockchange", onLock);
    return () => { ro.disconnect(); document.removeEventListener("pointerlockchange", onLock); };
  });
  $effect(() => {
    if (active) untrack(() => { paint(); canvas.focus(); });
    else untrack(() => { releaseKeys(); if (document.pointerLockElement === canvas) document.exitPointerLock(); });
  });
  $effect(() => { if (mouse === "absolute" && untrack(() => document.pointerLockElement === canvas)) document.exitPointerLock(); });

  const chip = "flex items-center gap-1.5 rounded-full bg-bar/85 px-2.5 py-1 text-[11px] text-muted backdrop-blur ring-1 ring-line";
</script>

<div bind:this={area} class="group absolute inset-0 bg-black" class:invisible={!active} role="tabpanel">
  <canvas bind:this={canvas} width={screen.width || 1024} height={screen.height || 768} tabindex="0"
    class="absolute inset-0 h-full w-full object-contain outline-none [image-rendering:pixelated] {mouse === 'absolute' ? 'cursor-none' : 'cursor-crosshair'}"
    onkeydown={(e) => key(e, true)} onkeyup={(e) => key(e, false)}
    onfocus={() => (focused = true)} onblur={() => { focused = false; releaseKeys(); }}
    onmouseenter={() => { guest = null; }}
    onmousedown={mousedown} onmouseup={mouseup} onpointermove={mousemove} oncontextmenu={(e) => e.preventDefault()}></canvas>

  <div class="pointer-events-none absolute top-2 right-2 flex items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 {stale ? '!opacity-100' : ''} {locked ? '!opacity-0' : ''}">
    <span class={chip} title={follow && live ? "The guest's screen: its display offers the tab's size (xrandr --output Virtual-1 --auto takes it)" : "/dev/fb0"}>{size || `${screen.width}×${screen.height}`}</span>
    <span class={chip} title={mouse === "absolute" ? "Absolute mouse: the cursor follows the pointer" : locked ? "Mouse captured: Esc releases it" : "Relative mouse: click to capture"}>
      {#if mouse === "absolute"}<MousePointer2 size={12} />{:else if locked}<Lock size={12} class="text-sakura" />{:else}<Move size={12} />{/if}
      <Keyboard size={12} class={focused ? "text-sakura" : ""} />
    </span>
    {#if stale}
      <button class="pointer-events-auto flex items-center gap-1.5 rounded-full bg-sakura px-2.5 py-1 text-[11px] font-bold text-bar hover:brightness-110"
        title="Restart the machine with the screen at the window's size (the disk stays)" onclick={onfit}><Maximize size={12} />{fitW}×{fitH}</button>
    {/if}
  </div>
</div>
