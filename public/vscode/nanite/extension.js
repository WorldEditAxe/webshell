// The Nanite machine in VS Code for the Web. Runs in VS Code's extension host (a web worker of the same origin as the page) and
// talks to the Nanite Webshell page over a BroadcastChannel named by the workspace's authority (the page's session):
//   request  { id, op, ...args }  ->  answer { id, ok, value | error }      events  { ev: "out" | "exit", pty, data | code }
// Files: the nanite: scheme, served by the page from the guest's file server. Terminals: bash in a pty of the machine.
const vscode = require("vscode");

const channels = new Map();
function channel(session) {
  let c = channels.get(session);
  if (!c) {
    const bc = new BroadcastChannel(`nanite-vscode-${session}`), waiting = new Map(), ptys = new Map();
    let next = 1;
    bc.onmessage = ({ data: m }) => {
      if (m.ev === "out") ptys.get(m.pty)?.out(m.data);
      else if (m.ev === "exit") ptys.get(m.pty)?.exit(m.code);
      else if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.ok ? w.res(m.value) : w.rej(m.error); }
    };
    const call = (op, args = {}, timeout = 30000) => new Promise((res, rej) => {
      const id = `x${next++}`;
      waiting.set(id, { res, rej });
      bc.postMessage({ id, op, ...args });
      setTimeout(() => { if (waiting.delete(id)) rej({ code: "Unavailable", message: "the Nanite page did not answer" }); }, timeout);
    });
    c = { call, ptys };
    channels.set(session, c);
  }
  return c;
}
const fsError = (e, uri) => {
  const msg = e?.message ?? String(e);
  if (e?.code === "FileNotFound" || /No such file/.test(msg)) return vscode.FileSystemError.FileNotFound(uri);
  if (/File exists/.test(msg)) return vscode.FileSystemError.FileExists(uri);
  if (/Not a directory/.test(msg)) return vscode.FileSystemError.FileNotADirectory(uri);
  if (/Is a directory/.test(msg)) return vscode.FileSystemError.FileIsADirectory(uri);
  if (/Permission denied/.test(msg)) return vscode.FileSystemError.NoPermissions(uri);
  if (e?.code === "Unavailable") return vscode.FileSystemError.Unavailable(uri);
  return new vscode.FileSystemError(msg);
};

class NaniteFS {
  constructor() { this._changed = new vscode.EventEmitter(); this.onDidChangeFile = this._changed.event; }
  async run(uri, op, args) { try { return await channel(uri.authority).call(op, { path: uri.path, ...args }); } catch (e) { throw fsError(e, uri); } }
  watch() { return new vscode.Disposable(() => {}); }
  async stat(uri) {
    const s = await this.run(uri, "stat");
    return { type: s.dir ? vscode.FileType.Directory : vscode.FileType.File, size: s.size, mtime: s.mtime, ctime: s.ctime };
  }
  async readDirectory(uri) {
    return (await this.run(uri, "ls")).map((e) => [e.name, e.dir ? vscode.FileType.Directory : vscode.FileType.File]);
  }
  async readFile(uri) { return await this.run(uri, "read"); }
  async writeFile(uri, content, options) {
    await this.run(uri, "write", { data: content, create: options.create, overwrite: options.overwrite });
    this._changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }
  async createDirectory(uri) { await this.run(uri, "mkdir"); this._changed.fire([{ type: vscode.FileChangeType.Created, uri }]); }
  async delete(uri) { await this.run(uri, "rm"); this._changed.fire([{ type: vscode.FileChangeType.Deleted, uri }]); }
  async rename(from, to, options) {
    await this.run(from, "mv", { to: to.path, overwrite: options.overwrite });
    this._changed.fire([{ type: vscode.FileChangeType.Deleted, uri: from }, { type: vscode.FileChangeType.Created, uri: to }]);
  }
}

// A terminal: bash in a new pty of the machine, in `cwd`.
function naniteTerminal(session, cwd) {
  const c = channel(session), write = new vscode.EventEmitter(), close = new vscode.EventEmitter();
  let id = null, size = { columns: 80, rows: 24 }, queued = [];
  const pty = {
    onDidWrite: write.event, onDidClose: close.event,
    async open(dims) {
      if (dims) size = dims;
      try {
        id = await c.call("ptyOpen", { cols: size.columns, rows: size.rows, cwd });
        c.ptys.set(id, { out: (d) => write.fire(d), exit: (code) => { c.ptys.delete(id); close.fire(code); } });
        for (const d of queued) c.call("ptyInput", { pty: id, data: d }); queued = [];
      } catch (e) { write.fire(`\x1b[31mcould not open a terminal on the machine: ${e?.message ?? e}\x1b[0m\r\n`); }
    },
    handleInput(data) { if (id === null) queued.push(data); else c.call("ptyInput", { pty: id, data }).catch(() => {}); },
    setDimensions(d) { size = d; if (id !== null) c.call("ptyResize", { pty: id, cols: d.columns, rows: d.rows }).catch(() => {}); },
    close() { if (id !== null) { c.ptys.delete(id); c.call("ptyClose", { pty: id }).catch(() => {}); } },
  };
  return { name: "shell", pty, iconPath: new vscode.ThemeIcon("terminal-linux") };
}
function workspaceSession() {
  const f = vscode.workspace.workspaceFolders?.find((w) => w.uri.scheme === "nanite");
  return f ? { session: f.uri.authority, cwd: f.uri.path } : null;
}

/** An address as typed (8000, localhost:8000/x, example.com, https://…) as a URL. */
function addressUrl(text) {
  let t = text.trim();
  if (/^\d+(\/.*)?$/.test(t)) t = `localhost:${t}`;
  if (/^https?:\/\//i.test(t)) return t;
  return (/^(localhost|127\.|0\.0\.0\.0|10\.0\.2\.15)/i.test(t) ? "http://" : "https://") + t;
}
// Lucide icons (the webshell's icon set), as SVG.
const ICON = (body) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const ICONS = {
  back: ICON('<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>'),
  fwd: ICON('<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>'),
  reload: ICON('<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>'),
  ext: ICON('<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
  zin: ICON('<circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="11" x2="11" y1="8" y2="14"/><line x1="8" x2="14" y1="11" y2="11"/>'),
  zout: ICON('<circle cx="11" cy="11" r="8"/><line x1="21" x2="16.65" y1="21" y2="16.65"/><line x1="8" x2="14" y1="11" y2="11"/>'),
  tools: ICON('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z"/>'),
  down: ICON('<path d="m6 9 6 6 6-6"/>'),
};
// The panel's page talks to the webshell page directly: the webview is of the webshell's origin (tools/patch-vscode-webview.py),
// so window.top is the webshell, which offers the proxy (naniteProxiedUrl / naniteUnproxiedUrl) and the devtools (naniteDevtools)
// of its Web Browser tab (src/lib/preview.ts).
function openBrowserPanel(call, first) {
  const panel = vscode.window.createWebviewPanel("nanite.browser", "Web Browser", vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true });
  panel.iconPath = new vscode.ThemeIcon("globe");
  panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; script-src * data: blob: 'unsafe-inline' 'unsafe-eval'; style-src * data: blob: 'unsafe-inline'; worker-src * data: blob:;">
<!-- Permissive: the devtools' sidebar (Chii's front end, a blob: page) inherits this page's policy, and loads its code from a CDN. -->
<style>
html,body{margin:0;height:100%;background:var(--vscode-editor-background);color:var(--vscode-foreground);font:12px var(--vscode-font-family)}
body{display:flex;flex-direction:column}
.bar{display:flex;gap:2px;align-items:center;padding:4px 6px;border-bottom:1px solid var(--vscode-panel-border,#4446)}
button{display:grid;place-items:center;background:none;border:0;color:inherit;min-width:26px;height:26px;padding:0 4px;border-radius:5px;cursor:pointer;font:inherit}
button:hover{background:var(--vscode-toolbar-hoverBackground,#fff2)}
button[aria-pressed=true]{background:var(--vscode-toolbar-activeBackground,#fff3);color:var(--vscode-focusBorder)}
input{flex:1;min-width:0;height:24px;margin:0 4px;padding:0 9px;border-radius:5px;border:1px solid var(--vscode-input-border,#4446);background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:inherit;outline:none}
input:focus{border-color:var(--vscode-focusBorder)}
.zoom{min-width:44px;font-variant-numeric:tabular-nums;color:var(--vscode-descriptionForeground)}
.sep{width:1px;height:16px;margin:0 3px;background:var(--vscode-panel-border,#4446)}
.menu{position:relative}
.menu ul{position:absolute;right:0;top:30px;z-index:5;margin:0;padding:4px;list-style:none;min-width:150px;border-radius:6px;border:1px solid var(--vscode-widget-border,#4446);background:var(--vscode-menu-background,var(--vscode-editor-background));box-shadow:0 4px 16px #0006}
.menu li button{width:100%;justify-content:start;padding:0 8px;display:flex;gap:6px}
.main{flex:1;display:flex;min-height:0}
.view{position:relative;flex:1;min-width:0;overflow:hidden;background:#fff}
#f{position:absolute;left:0;top:0;border:0;transform-origin:0 0;color-scheme:light}
.side{display:none;position:relative;width:420px;min-width:240px;border-left:1px solid var(--vscode-panel-border,#4446)}
.side.on{display:block}
.grip{position:absolute;left:-4px;top:0;bottom:0;width:8px;cursor:col-resize;z-index:3}
.grip:hover,.grip.on{background:var(--vscode-focusBorder);opacity:.5}
body.dragging iframe{pointer-events:none}
.side iframe{width:100%;height:100%;border:0}
.err{padding:8px 12px;color:var(--vscode-errorForeground);border-bottom:1px solid var(--vscode-panel-border,#4446)}
</style></head><body>
<div class="bar">
  <button id="back" title="Back">${ICONS.back}</button><button id="fwd" title="Forward">${ICONS.fwd}</button><button id="reload" title="Reload">${ICONS.reload}</button>
  <input id="addr" spellcheck="false" aria-label="Address" placeholder="8000, localhost:8000/path or a web address">
  <button id="zout" title="Zoom out">${ICONS.zout}</button><button id="zreset" class="zoom" title="Reset zoom">100%</button><button id="zin" title="Zoom in">${ICONS.zin}</button>
  <span class="sep"></span>
  <button id="tools" title="Devtools (reloads the page with them)" aria-pressed="false">${ICONS.tools}</button>
  <span class="menu"><button id="toolsmenu" title="Which devtools">${ICONS.down}</button><ul id="list" hidden></ul></span>
  <button id="ext" title="Open in a browser tab">${ICONS.ext}</button>
</div>
<div id="err" class="err" hidden></div>
<div class="main"><div class="view"><iframe id="f" title="page"></iframe></div><div class="side" id="side"><div class="grip" id="grip" title="Drag to resize"></div></div></div>
<script>
const vs = acquireVsCodeApi(), $ = (id) => document.getElementById(id);
const f = $("f"), addr = $("addr"), err = $("err"), side = $("side");
const N = (() => { try { const t = window.top; return t && t.naniteProxiedUrl ? t : null; } catch { return null; } })();
const fail = (m) => { err.hidden = false; err.textContent = m; };
if (!N) fail("The webshell page is older than this panel: reload the webshell page (it gives the panel its proxy and devtools).");
const store = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };
const load = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

// Addresses: what is typed, made a URL (a port of the machine, localhost:PORT/x, a site), then its proxied address.
const toUrl = (t) => { t = t.trim(); if (/^\\d+(\\/.*)?$/.test(t)) t = "localhost:" + t; if (/^https?:\\/\\//i.test(t)) return t;
  return (/^(localhost|127\\.|0\\.0\\.0\\.0|10\\.0\\.2\\.15)/i.test(t) ? "http://" : "https://") + t; };
let editing = false, last = "";
async function go(text) {
  const url = toUrl(text);
  if (!N) return;
  try { err.hidden = true; f.src = await N.naniteProxiedUrl(url); if (!editing) addr.value = url; }
  catch (e) { fail("Could not open " + url + ": " + (e && e.message || e)); }
}
addr.addEventListener("focus", () => { editing = true; addr.select(); });
addr.addEventListener("blur", () => { editing = false; });
addr.addEventListener("keydown", (e) => { if (e.key === "Enter") { go(addr.value); addr.blur(); } else if (e.key === "Escape") addr.blur(); });
const hist = (d) => { try { f.contentWindow.history.go(d); } catch {} };
$("back").onclick = () => hist(-1); $("fwd").onclick = () => hist(1);
$("reload").onclick = () => { try { f.contentWindow.location.reload(); } catch { f.src = f.src; } };
$("ext").onclick = () => { let h = f.src; try { h = f.contentWindow.location.href; } catch {} vs.postMessage({ type: "external", src: h }); };

// Zoom: the page scaled (its frame made 1/zoom as big, then scaled back down or up), as the Web Browser tab does.
const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
let zoom = 1;
function setZoom(z) { zoom = z; f.style.width = (100 / z) + "%"; f.style.height = (100 / z) + "%"; f.style.transform = "scale(" + z + ")"; $("zreset").textContent = Math.round(z * 100) + "%"; }
$("zin").onclick = () => setZoom(ZOOMS.find((z) => z > zoom + 0.001) ?? zoom);
$("zout").onclick = () => setZoom([...ZOOMS].reverse().find((z) => z < zoom - 0.001) ?? zoom);
$("zreset").onclick = () => setZoom(1);
setZoom(1);

// Devtools: Eruda or Chii (Chrome DevTools), in a sidebar, put into the page as it loads (the webshell's code, so the same fixes).
const DT_KEY = "nanite-preview-devtools";
let mode = load(DT_KEY), on = false;
const names = (N && N.naniteDevtools && N.naniteDevtools.names) || { eruda: "Eruda", chii: "Chrome DevTools" };
const list = $("list");
list.innerHTML = Object.entries(names).map(([k, v]) => '<li><button data-mode="' + k + '">' + v + '</button></li>').join("");
function renderMenu() { for (const b of list.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.mode === mode)); $("tools").title = mode ? "Devtools (" + names[mode] + "): reloads the page with them" : "Devtools"; }
// The sidebar's width: its left edge drags (the frames ignore the pointer meanwhile); kept like the Web Browser tab's.
const W_KEY = "nanite-preview-devtools-width", grip = $("grip");
side.style.width = Math.max(240, +(load(W_KEY) || 0) || 420) + "px";
grip.addEventListener("pointerdown", (e) => {
  e.preventDefault(); grip.setPointerCapture(e.pointerId); grip.classList.add("on"); document.body.classList.add("dragging");
  const move = (m) => { const r = document.querySelector(".main").getBoundingClientRect(); side.style.width = Math.round(Math.min(Math.max(240, r.right - m.clientX), r.width - 160)) + "px"; };
  const up = () => { grip.classList.remove("on"); document.body.classList.remove("dragging"); store(W_KEY, String(parseInt(side.style.width))); grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); grip.removeEventListener("lostpointercapture", up); };
  grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", up); grip.addEventListener("lostpointercapture", up);
});
function makeSide() {
  for (const x of [...side.querySelectorAll("iframe")]) x.remove();
  const s = document.createElement("iframe"); s.title = mode === "chii" ? "Chrome DevTools" : "Eruda";
  if (mode === "eruda" && N) s.srcdoc = N.naniteDevtools.erudaDoc;
  side.appendChild(s); return s;
}
function setTools(v) {
  if (v && !mode) { list.hidden = false; return; }
  on = v; $("tools").setAttribute("aria-pressed", String(on)); side.classList.toggle("on", on);
  if (on) makeSide(); else for (const x of [...side.querySelectorAll("iframe")]) x.remove();
  $("reload").click();
}
$("tools").onclick = () => setTools(!on);
$("toolsmenu").onclick = (e) => { e.stopPropagation(); list.hidden = !list.hidden; };
list.onclick = (e) => { const b = e.target.closest("button"); if (!b) return; mode = b.dataset.mode; store(DT_KEY, mode); list.hidden = true; renderMenu(); setTools(true); };
document.addEventListener("click", (e) => { if (!e.target.closest(".menu")) list.hidden = true; });
renderMenu();
f.addEventListener("load", () => {
  if (on && mode && N && N.naniteDevtools) { const s = side.querySelector("iframe") || makeSide(); try { N.naniteDevtools.attach(f, s, mode); } catch (e) { fail("Devtools: " + (e && e.message || e)); } }
});
// Chii's front end posts to the window holding its sidebar: this one; the webshell passes it on to the page.
window.addEventListener("message", (e) => { try { N && N.naniteDevtools && N.naniteDevtools.relay(e); } catch {} });

// Where the frame is now (links, redirects, back / forward): the real address in the bar, the title on the tab.
setInterval(async () => {
  let h = ""; try { h = f.contentWindow.location.href; } catch {}
  if (!h || h === last || h === "about:blank" || !N) return;
  last = h;
  let url = h; try { url = await N.naniteUnproxiedUrl(h); } catch {}
  if (!editing) addr.value = url;
  let t = ""; try { t = f.contentDocument.title; } catch {}
  vs.postMessage({ type: "title", title: t, url });
}, 500);
go(${JSON.stringify(first)});
</script></body></html>`;
  panel.webview.onDidReceiveMessage((m) => {
    if (m.type === "title") { try { panel.title = m.title || new URL(m.url).host || "Web Browser"; } catch { panel.title = m.title || "Web Browser"; } }
    else if (m.type === "external" && m.src) vscode.env.openExternal(vscode.Uri.parse(m.src));
  });
}

/** A path typed by the user, made absolute: ~ is root's home (/root), a relative path is from `cwd`; . and .. are resolved. */
function absolute(p, cwd) {
  p = p.trim();
  if (p === "~" || p.startsWith("~/")) p = "/root" + p.slice(1);
  else if (!p.startsWith("/")) p = `${cwd}/${p}`;
  const out = [];
  for (const part of p.split("/")) { if (!part || part === ".") continue; if (part === "..") out.pop(); else out.push(part); }
  return "/" + out.join("/");
}

exports.activate = (context) => {
  const sub = (d) => context.subscriptions.push(d);
  sub(vscode.workspace.registerFileSystemProvider("nanite", new NaniteFS(), { isCaseSensitive: true }));
  sub(vscode.window.registerTerminalProfileProvider("nanite.bash", {
    provideTerminalProfile() { const w = workspaceSession(); return w ? new vscode.TerminalProfile(naniteTerminal(w.session, w.cwd)) : undefined; },
  }));
  const w = workspaceSession();
  const call = (op, args) => (w ? channel(w.session).call(op, args) : Promise.reject(new Error("not a Nanite workspace")));
  sub(vscode.commands.registerCommand("nanite.newTerminal", () => { if (w) vscode.window.createTerminal(naniteTerminal(w.session, w.cwd)).show(); }));
  sub(vscode.commands.registerCommand("nanite.openFolder", async () => {
    if (!w) return;
    const input = await vscode.window.showInputBox({ title: "Open a folder on the machine", value: w.cwd, prompt: "A path: /abs, ~/in-home or relative to the open folder",
      validateInput: (v) => (v.trim() ? null : "a path") });
    if (!input) return;
    const path = absolute(input, w.cwd);
    try {
      const st = await vscode.workspace.fs.stat(vscode.Uri.from({ scheme: "nanite", authority: w.session, path }));
      if (!(st.type & vscode.FileType.Directory)) { vscode.window.showErrorMessage(`${path} is not a folder`); return; }
    } catch { vscode.window.showErrorMessage(`${path}: no such folder on the machine`); return; }
    await call("openFolder", { path });
  }));
  sub(vscode.commands.registerCommand("nanite.openRoot", () => call("openFolder", { path: "/" })));
  sub(vscode.commands.registerCommand("nanite.storage", () => call("storage")));
  sub(vscode.commands.registerCommand("nanite.disableCodeMode", () => call("disableCodeMode")));
  // The Web Browser in VS Code: a panel of its own (a webview) whose address bar, back / forward / reload all go through the
  // webshell's proxy (Scramjet, as in the Web Browser tab): the machine's ports as localhost:PORT, and the web. (VS Code's Simple
  // Browser would load what is typed in its address bar directly, not through the proxy.)
  sub(vscode.commands.registerCommand("nanite.openBrowser", async (arg) => {
    const input = typeof arg === "string" ? arg : await vscode.window.showInputBox({ title: "Open in the Web Browser", value: "localhost:8000",
      prompt: "A port of the machine (8000, localhost:8000/path) or a web address", validateInput: (v) => (v.trim() ? null : "an address") });
    if (input) openBrowserPanel(call, addressUrl(input));
  }));
  sub(vscode.commands.registerCommand("nanite.info", async () => {
    const i = await call("info").catch(() => null);
    if (i) vscode.window.showInformationMessage(`Nanite · ${i.root} · ${i.memory} MiB`);
  }));
  if (!w) return;
  // The root in the status bar, next to the remote indicator.
  const item = vscode.window.createStatusBarItem("nanite.root", vscode.StatusBarAlignment.Left, 1000);
  item.name = "Nanite root"; item.text = "$(vm) Nanite"; item.command = "nanite.storage"; item.tooltip = "The machine's root filesystem: switch";
  item.show(); sub(item);
  call("info").then((i) => {
    item.text = `$(vm) ${i.root}`; item.tooltip = `${i.root} · ${i.memory} MiB · click to switch roots`;
    // VS Code mode (the page is this VS Code alone): say how to leave it, and offer the command in the palette.
    if (!i.codeMode) return;
    vscode.commands.executeCommand("setContext", "nanite.codeMode", true);
    vscode.window.showInformationMessage("Visual Studio Code mode is on. To go back at any time, click the button below or run Nanite > Disable VS Code Mode from the command palette.",
      { modal: true }, "Disable").then((a) => { if (a === "Disable") call("disableCodeMode").catch(() => {}); });
  }, () => {});
  // No terminal until one is asked for (Terminal > New Terminal, Ctrl+`): on Nanite a second interactive shell waiting at its
  // prompt keeps the machine busy (a full core, reports/nanite-bugs.md), so VS Code does not open one by itself.
};
exports.deactivate = () => {};
