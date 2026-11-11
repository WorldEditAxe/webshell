// Themes: the page's colours (Tailwind's --color-* tokens, set on :root), the terminals' palette (xterm.js), and VS Code's (its
// colour customizations, read by public/vscode/index.html from localStorage). The top bar ("bar") is darker than the terminal
// ("bg") in every theme, so the two stand apart. Catppuccin, Nord, Gruvbox and Tokyo Night are their published palettes (MIT).
import type { ITheme } from "@xterm/xterm";

export interface Theme {
  id: string; name: string; dark: boolean;
  ui: { bar: string; bg: string; panel: string; raised: string; line: string; fg: string; muted: string; sakura: string; blossom: string; danger: string };
  term: ITheme;
}
const ansi = (n: string[], b: string[]) => ({
  black: n[0], red: n[1], green: n[2], yellow: n[3], blue: n[4], magenta: n[5], cyan: n[6], white: n[7],
  brightBlack: b[0], brightRed: b[1], brightGreen: b[2], brightYellow: b[3], brightBlue: b[4], brightMagenta: b[5], brightCyan: b[6], brightWhite: b[7],
});

export const THEMES: Theme[] = [
  { id: "sakura", name: "Afterglow Sakura", dark: true,
    ui: { bar: "#141114", bg: "#221d21", panel: "#1a1619", raised: "#2b2429", line: "#4a3442", fg: "#d6cfd3", muted: "#7a6c75", sakura: "#f2b5c8", blossom: "#b0798f", danger: "#cc5a64" },
    term: { background: "#221d21", foreground: "#d6cfd3", cursor: "#f2b5c8", cursorAccent: "#221d21", selectionBackground: "#4a3442", selectionForeground: "#f0e6eb",
      ...ansi(["#171316", "#ac4142", "#7e8e50", "#e5b567", "#6c99bb", "#b05a8e", "#7dd6cf", "#d6cfd3"], ["#5a4f56", "#ac4142", "#7e8e50", "#e5b567", "#6c99bb", "#e39cbc", "#7dd6cf", "#f7f0f3"]) } },
  { id: "catppuccin", name: "Catppuccin Mocha", dark: true,
    ui: { bar: "#11111b", bg: "#1e1e2e", panel: "#181825", raised: "#313244", line: "#45475a", fg: "#cdd6f4", muted: "#7f849c", sakura: "#f5c2e7", blossom: "#cba6f7", danger: "#f38ba8" },
    term: { background: "#1e1e2e", foreground: "#cdd6f4", cursor: "#f5e0dc", cursorAccent: "#1e1e2e", selectionBackground: "#585b70",
      ...ansi(["#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#bac2de"], ["#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#f5c2e7", "#94e2d5", "#a6adc8"]) } },
  { id: "tokyo", name: "Tokyo Night", dark: true,
    ui: { bar: "#101014", bg: "#1a1b26", panel: "#16161e", raised: "#24283b", line: "#2f334d", fg: "#c0caf5", muted: "#565f89", sakura: "#7aa2f7", blossom: "#bb9af7", danger: "#f7768e" },
    term: { background: "#1a1b26", foreground: "#c0caf5", cursor: "#c0caf5", cursorAccent: "#1a1b26", selectionBackground: "#33467c",
      ...ansi(["#15161e", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6"], ["#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5"]) } },
  { id: "nord", name: "Nord", dark: true,
    ui: { bar: "#1f232b", bg: "#2e3440", panel: "#272c36", raised: "#3b4252", line: "#434c5e", fg: "#d8dee9", muted: "#7b88a1", sakura: "#88c0d0", blossom: "#5e81ac", danger: "#bf616a" },
    term: { background: "#2e3440", foreground: "#d8dee9", cursor: "#d8dee9", cursorAccent: "#2e3440", selectionBackground: "#434c5e",
      ...ansi(["#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0"], ["#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"]) } },
  { id: "gruvbox", name: "Gruvbox", dark: true,
    ui: { bar: "#161819", bg: "#282828", panel: "#1d2021", raised: "#3c3836", line: "#504945", fg: "#ebdbb2", muted: "#928374", sakura: "#fabd2f", blossom: "#d79921", danger: "#fb4934" },
    term: { background: "#282828", foreground: "#ebdbb2", cursor: "#ebdbb2", cursorAccent: "#282828", selectionBackground: "#504945",
      ...ansi(["#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984"], ["#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"]) } },
  { id: "sakura-light", name: "Sakura Light", dark: false,
    ui: { bar: "#ead9e1", bg: "#fbf5f7", panel: "#f4e9ee", raised: "#efe0e7", line: "#e0c7d2", fg: "#4a3a42", muted: "#9a8790", sakura: "#c25b84", blossom: "#d98aa8", danger: "#c0392b" },
    term: { background: "#fbf5f7", foreground: "#4a3a42", cursor: "#c25b84", cursorAccent: "#fbf5f7", selectionBackground: "#f2d3df",
      ...ansi(["#4a3a42", "#b8434f", "#5f7a2c", "#a8741a", "#3f6f9a", "#b0497f", "#2f8f88", "#d9cdd3"], ["#8a7880", "#d0505d", "#6f8c35", "#c08a25", "#4f84b3", "#c25b84", "#3aa39b", "#fffafc"]) } },
];
export const DEFAULT_THEME = "gruvbox";

// ---- Themes people make (Settings > Terminal): kept in this browser next to the built-in ones ----
// A theme is this file's Theme as JSON, or a Windows Terminal colour scheme ({name, background, foreground, cursorColor,
// selectionBackground, black … brightWhite}: thousands are shared, e.g. windowsterminalthemes.dev), whose page colours are derived
// from its palette. Several at once: a JSON array.
const USER_KEY = "nanite-webshell:themes";
export function userThemes(): Theme[] {
  try { const v = JSON.parse(localStorage.getItem(USER_KEY) ?? "[]"); return Array.isArray(v) ? v.filter(isTheme) : []; } catch { return []; }
}
function storeUserThemes(list: Theme[]): void { try { localStorage.setItem(USER_KEY, JSON.stringify(list)); } catch {} }
export const allThemes = (): Theme[] => [...THEMES, ...userThemes()];
export const isUserTheme = (id: string) => id.startsWith("user-");
export const theme = (id: string): Theme => allThemes().find((t) => t.id === id) ?? THEMES.find((t) => t.id === DEFAULT_THEME)!;

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const UI_KEYS = ["bar", "bg", "panel", "raised", "line", "fg", "muted", "sakura", "blossom", "danger"] as const;
const ANSI_KEYS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;
function isTheme(t: unknown): t is Theme {
  const x = t as Theme;
  return !!x && typeof x.id === "string" && typeof x.name === "string" && !!x.ui && !!x.term && UI_KEYS.every((k) => HEX.test(x.ui[k] ?? ""));
}
const rgb = (h: string) => { let x = h.slice(1); if (x.length === 3) x = [...x].map((c) => c + c).join(""); return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16)); };
const hex = (c: number[]) => "#" + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");
const mix = (a: string, b: string, f: number) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i]! - v) * f)); };
const luminance = (h: string) => { const [r, g, b] = rgb(h).map((v) => v / 255); return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!; };

/** The page's colours from a terminal palette: the bar darker than the background, panels between, the accent from the palette. */
function uiFrom(term: ITheme, dark: boolean): Theme["ui"] {
  const bg = term.background!, fg = term.foreground!, edge = dark ? "#000000" : "#ffffff";
  return {
    bar: mix(bg, edge, dark ? 0.35 : 0.06), bg, panel: mix(bg, edge, dark ? 0.18 : 0.03), raised: mix(bg, fg, 0.1), line: mix(bg, fg, 0.22),
    fg, muted: mix(bg, fg, 0.5), sakura: term.brightMagenta ?? term.magenta ?? term.cursor ?? fg, blossom: term.magenta ?? term.blue ?? fg, danger: term.red ?? "#cc3333",
  };
}

/** Themes from text people paste or load: this app's theme JSON, a Windows Terminal scheme, or an array of either. */
export function parseThemes(text: string): Theme[] {
  const v = JSON.parse(text) as unknown;
  const one = (o: Record<string, unknown>): Theme => {
    const name = String(o.name ?? "").trim() || "My theme";
    const id = `user-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "theme"}`;
    if (o.ui && o.term) {
      const t = o as unknown as Theme, base = theme(DEFAULT_THEME);
      const ui = { ...base.ui, ...Object.fromEntries(Object.entries(t.ui).filter(([, c]) => HEX.test(String(c)))) } as Theme["ui"];
      return { id, name, dark: t.dark ?? luminance(ui.bg) < 0.5, ui, term: { ...base.term, ...t.term } };
    }
    // Windows Terminal: background, foreground, cursorColor, selectionBackground, and the 16 colours by name.
    const term: ITheme = {};
    for (const k of ["background", "foreground", ...ANSI_KEYS] as const) {
      const c = String(o[k] ?? ""); if (!HEX.test(c)) throw new Error(`"${name}": ${k} is missing or not a #colour`);
      (term as Record<string, string>)[k] = c;
    }
    term.cursor = HEX.test(String(o.cursorColor ?? "")) ? String(o.cursorColor) : term.foreground;
    term.cursorAccent = term.background;
    term.selectionBackground = HEX.test(String(o.selectionBackground ?? "")) ? String(o.selectionBackground) : mix(term.background!, term.foreground!, 0.25);
    const dark = luminance(term.background!) < 0.5;
    return { id, name, dark, ui: uiFrom(term, dark), term };
  };
  const list = (Array.isArray(v) ? v : [v]).map((x) => one(x as Record<string, unknown>));
  if (!list.length) throw new Error("no theme in it");
  return list;
}
/** Adds (or replaces, same name) themes people made; returns them. */
export function saveUserThemes(list: Theme[]): Theme[] {
  const mine = userThemes().filter((t) => !list.some((n) => n.id === t.id));
  storeUserThemes([...mine, ...list]);
  return list;
}
export function deleteUserTheme(id: string): void { storeUserThemes(userThemes().filter((t) => t.id !== id)); }
/** A theme as JSON to share (without its id: the importer makes one from the name). */
export const exportTheme = (t: Theme): string => JSON.stringify({ name: t.name, dark: t.dark, ui: t.ui, term: t.term }, null, 2);

/** Colours the page and hands VS Code its colours. */
export function applyTheme(t: Theme): void {
  const s = document.documentElement.style;
  for (const [k, v] of Object.entries(t.ui)) s.setProperty(`--color-${k}`, v);
  s.colorScheme = t.dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t.ui.bar);
  const x = t.term;
  const vscode = {
    colorTheme: t.dark ? "Default Dark Modern" : "Default Light Modern",
    colors: {
      "editor.background": t.ui.bg, "editor.foreground": t.ui.fg, "editorCursor.foreground": x.cursor, "editor.selectionBackground": x.selectionBackground,
      "editor.lineHighlightBackground": t.ui.raised + "80", "editorLineNumber.foreground": t.ui.muted, "editorLineNumber.activeForeground": t.ui.sakura,
      "sideBar.background": t.ui.panel, "sideBarSectionHeader.background": t.ui.panel, "activityBar.background": t.ui.bar, "activityBar.foreground": t.ui.sakura,
      "activityBarBadge.background": t.ui.sakura, "activityBarBadge.foreground": t.ui.bar, "titleBar.activeBackground": t.ui.bar, "titleBar.inactiveBackground": t.ui.bar,
      "statusBar.background": t.ui.bar, "statusBar.foreground": t.ui.muted, "statusBar.noFolderBackground": t.ui.bar,
      "statusBarItem.remoteBackground": t.ui.sakura, "statusBarItem.remoteForeground": t.ui.bar,
      "editorGroupHeader.tabsBackground": t.ui.panel, "tab.activeBackground": t.ui.bg, "tab.inactiveBackground": t.ui.panel, "tab.activeBorderTop": t.ui.sakura,
      "panel.background": t.ui.bg, "panel.border": t.ui.line, "terminal.background": x.background, "terminal.foreground": x.foreground,
      "terminalCursor.foreground": x.cursor, "focusBorder": t.ui.blossom, "button.background": t.ui.sakura, "button.foreground": t.ui.bar,
      "input.background": t.ui.panel, "input.border": t.ui.line, "dropdown.background": t.ui.panel, "list.activeSelectionBackground": t.ui.raised,
      "list.hoverBackground": t.ui.raised + "99", "list.inactiveSelectionBackground": t.ui.raised, "editorWidget.background": t.ui.panel,
      "quickInput.background": t.ui.panel, "menu.background": t.ui.panel, "scrollbarSlider.background": t.ui.line + "80",
      ...Object.fromEntries((["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const).flatMap((c) => {
        const C = c[0]!.toUpperCase() + c.slice(1), B = `bright${C}` as keyof ITheme;
        return [[`terminal.ansi${C}`, x[c] as string], [`terminal.ansiBright${C}`, x[B] as string]];
      })),
    },
  };
  try { localStorage.setItem("nanite-webshell:vscode-theme", JSON.stringify(vscode)); } catch {}
}
