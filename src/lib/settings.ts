// Nanite's launch parameters: the defaults, what the settings dialog saved (localStorage), and what the URL says (it wins).
export interface Launch {
  /** The machine's memory cap, MiB: kernel + every process + caches, as Nanite counts it. */
  memory: number;
  /** One process's guest memory cap, MiB; null: min(memory, 256). */
  processMemory: number | null;
  /** The disk root's metadata kept in the kernel's memory, MiB; null: Nanite's default (16). */
  dcache: number | null;
  /** The virtual screen (/dev/fb0), pixels; null: the monitor tab's size when the machine starts. */
  screenWidth: number | null;
  screenHeight: number | null;
  /** A Wisp server (wss://...); empty: the nearest of Spark's relays. */
  wisp: string;
  /** Where Nanite comes from: <pkg>/lib/nanitevisor/. */
  pkg: string;
  /** The terminals (they apply at once, without a restart). */
  fontSize: number;
  lineHeight: number;
  cursorStyle: "bar" | "block" | "underline";
  cursorBlink: boolean;
  scrollback: number;
  ligatures: boolean;
  bell: "thock" | "off";
  /** lib/themes.ts: the page's, the terminals' and VS Code's colours. */
  theme: string;
  /** The monitor's mouse: relative (pointer lock, like a real mouse) or absolute (the guest's cursor goes where you point). */
  mouse: "relative" | "absolute";
}
export const TERMINAL_KEYS = ["fontSize", "lineHeight", "cursorStyle", "cursorBlink", "scrollback", "ligatures", "bell", "theme", "mouse"] as const;
export type TerminalOptions = Pick<Launch, (typeof TERMINAL_KEYS)[number]>;

export const DEFAULTS: Launch = {
  memory: 512, processMemory: null, dcache: null, screenWidth: null, screenHeight: null,
  wisp: "", pkg: "https://packages.sparkpowered.org",
  fontSize: 13, lineHeight: 1.12, cursorStyle: "bar", cursorBlink: true, scrollback: 10000, ligatures: true, bell: "thock", theme: "sakura", mouse: "relative",
};

const KEY = "nanite-webshell:launch";

export function saved(): Partial<Launch> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {}; } catch { return {}; }
}
export function save(l: Launch): void {
  try { localStorage.setItem(KEY, JSON.stringify(l)); } catch {}
}

/** ?mem= ?wisp= ?pkg= ?size= in the page's URL, which override the saved settings. */
export function fromUrl(): Partial<Launch> {
  const q = new URLSearchParams(location.search), o: Partial<Launch> = {};
  if (q.get("mem")) o.memory = +q.get("mem")!;
  if (q.get("wisp")) o.wisp = q.get("wisp")!;
  if (q.get("pkg")) o.pkg = q.get("pkg")!.replace(/\/$/, "");
  if (q.get("size")) o.fontSize = +q.get("size")!;
  return o;
}

export const effective = (): Launch => ({ ...DEFAULTS, ...saved(), ...fromUrl() });

/** Whether two settings need different machines (everything but the terminal options and the mouse mode does). */
export const needsRestart = (a: Launch, b: Launch): boolean =>
  (Object.keys(DEFAULTS) as (keyof Launch)[]).some((k) => !(TERMINAL_KEYS as readonly string[]).includes(k) && a[k] !== b[k]);
export const terminalOptions = (l: Launch): TerminalOptions => Object.fromEntries(TERMINAL_KEYS.map((k) => [k, l[k]])) as TerminalOptions;
