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
  sub(vscode.commands.registerCommand("nanite.info", async () => {
    const i = await call("info").catch(() => null);
    if (i) vscode.window.showInformationMessage(`Nanite · ${i.root} · ${i.memory} MiB`);
  }));
  if (!w) return;
  // The root in the status bar, next to the remote indicator.
  const item = vscode.window.createStatusBarItem("nanite.root", vscode.StatusBarAlignment.Left, 1000);
  item.name = "Nanite root"; item.text = "$(vm) Nanite"; item.command = "nanite.storage"; item.tooltip = "The machine's root filesystem: switch";
  item.show(); sub(item);
  call("info").then((i) => { item.text = `$(vm) ${i.root}`; item.tooltip = `${i.root} · ${i.memory} MiB · click to switch roots`; }, () => {});
  // A terminal from the start, as in a desktop VS Code window opened on a folder with the panel up.
  if (vscode.window.terminals.length === 0) vscode.window.createTerminal(naniteTerminal(w.session, w.cwd)).show(true);
};
exports.deactivate = () => {};
