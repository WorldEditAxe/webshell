// One xterm.js terminal (a tab), its bell, and the boot progress bars.
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { LigaturesAddon } from "@xterm/addon-ligatures";
import type { TerminalOptions } from "./settings";
import { theme } from "./themes";

export const C = { dim: "\x1b[38;2;122;108;117m", pink: "\x1b[38;2;242;181;200m", lilac: "\x1b[38;2;214;207;211m", red: "\x1b[1;38;2;204;90;100m", off: "\x1b[0m" };

// Bell (BEL, \a): xterm.js makes no sound itself, so play a soft "thock" like a keyboard key bottoming out: a low body
// whose pitch drops (200 -> 90 Hz in 70 ms) plus a 10 ms burst of low-passed noise for the contact.
let audio: AudioContext | null = null, lastBell = 0;
export let bellOn = true;
function thock(): void {
  if (!bellOn) return;
  const now = performance.now(); if (now - lastBell < 80) return; lastBell = now;
  try {
    audio ??= new AudioContext();
    const a = audio, t = a.currentTime, out = a.createGain();
    out.gain.value = 0.5; out.connect(a.destination);
    const body = a.createOscillator(), bg = a.createGain();
    body.type = "sine"; body.frequency.setValueAtTime(200, t); body.frequency.exponentialRampToValueAtTime(90, t + 0.07);
    bg.gain.setValueAtTime(0.0001, t); bg.gain.exponentialRampToValueAtTime(0.5, t + 0.003); bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    body.connect(bg).connect(out); body.start(t); body.stop(t + 0.1);
    const n = a.createBuffer(1, Math.ceil(a.sampleRate * 0.012), a.sampleRate), d = n.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length) ** 2;
    const click = a.createBufferSource(), lp = a.createBiquadFilter(), cg = a.createGain();
    lp.type = "lowpass"; lp.frequency.value = 1800; cg.gain.value = 0.35; click.buffer = n;
    click.connect(lp).connect(cg).connect(out); click.start(t);
  } catch {}
}

export class Shell {
  readonly term: Terminal;
  private readonly fitter = new FitAddon();
  private raf = 0;
  private ligatures: LigaturesAddon | null = null;
  private opts: TerminalOptions;
  /** What the user types, and the size after each fit: wired to the machine's console or one of its terminals. */
  onInput: (data: string) => void = () => {};
  onResize: (cols: number, rows: number) => void = () => {};
  /** BEL arrived (the tab is flagged when it is not the one shown). */
  onBell: () => void = () => {};

  constructor(o: TerminalOptions) {
    this.opts = o;
    this.term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace',
      fontSize: o.fontSize, lineHeight: o.lineHeight, letterSpacing: 0,
      cursorBlink: o.cursorBlink, cursorStyle: o.cursorStyle, allowProposedApi: true,
      scrollback: o.scrollback, theme: theme(o.theme).term, macOptionIsMeta: true,
    });
    bellOn = o.bell !== "off";
    this.term.loadAddon(this.fitter);
    this.term.loadAddon(new WebLinksAddon());
    this.term.loadAddon(new Unicode11Addon()); this.term.unicode.activeVersion = "11";
    this.term.onBell(() => { thock(); this.onBell(); });
    this.term.onData((d) => this.onInput(d));
  }
  mount(el: HTMLElement): void {
    this.term.open(el);
    this.setLigatures(this.opts.ligatures);
    this.refit();
  }
  /** Fits the terminal to its box (skipped while the box has no size) and reports the size. */
  refit(): void {
    if (!this.term.element?.parentElement?.clientWidth) return;
    try { this.fitter.fit(); } catch { return; }
    this.onResize(this.term.cols, this.term.rows);
  }
  scheduleFit(): void { cancelAnimationFrame(this.raf); this.raf = requestAnimationFrame(() => this.refit()); }
  // JetBrains Mono's programming ligatures (-> => != === ...): the addon joins those sequences into one cell run and turns on "calt".
  private setLigatures(on: boolean): void {
    if (on && !this.ligatures) { this.ligatures = new LigaturesAddon(); this.term.loadAddon(this.ligatures); }
    else if (!on && this.ligatures) { this.ligatures.dispose(); this.ligatures = null; }
  }
  /** Applies the terminal settings (all of them take effect at once). */
  configure(o: TerminalOptions): void {
    this.opts = o;
    Object.assign(this.term.options, { theme: theme(o.theme).term, fontSize: o.fontSize, lineHeight: o.lineHeight, cursorStyle: o.cursorStyle, cursorBlink: o.cursorBlink, scrollback: o.scrollback });
    bellOn = o.bell !== "off";
    if (this.term.element) this.setLigatures(o.ligatures);
    this.refit();
  }
  dispose(): void { cancelAnimationFrame(this.raf); this.term.dispose(); }
}

/** Progress bars in a terminal, redrawn in place: one row per bar. */
export class Bars {
  private readonly bars: { label: string; f: number | null; note: string }[] = [];
  constructor(private readonly term: Terminal) {}
  add(label: string) { const b = { label, f: null as number | null, note: "" }; this.bars.push(b); this.term.write("\r\n"); this.draw(); return b; }
  draw(): void {
    const w = Math.max(10, Math.min(40, this.term.cols - 40));
    let s = `\x1b[${this.bars.length}A`;
    for (const b of this.bars) {
      const n = b.f == null ? -1 : Math.round(Math.min(1, b.f) * w);
      const fill = n < 0 ? `${C.dim}${"╌".repeat(w)}` : `${C.pink}${"━".repeat(n)}${C.dim}${"─".repeat(w - n)}`;
      const pct = b.f == null ? "    " : `${String(Math.round(Math.min(1, b.f) * 100)).padStart(3)}%`;
      s += `\r\x1b[2K  ${C.lilac}${b.label.padEnd(7)}${C.off} ${fill}${C.off} ${pct}  ${C.dim}${b.note}${C.off}\r\n`;
    }
    this.term.write(s);
  }
}
