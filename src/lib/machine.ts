// The machine: Ubuntu 26.04 on Nanite (x86-64 in WebAssembly, no kernel), from the Spark Linux package host; its network goes
// out through the nearest of Spark Linux's Wisp relays. Also the ICMP bridge for ping, and the disk's save / load / reset.
import type { Launch } from "./settings";
import { locate } from "./wisp";

// The parts of Nanite's page API (lib/nanitevisor/nanite.js, nanite.ts in its source map) this page uses.
export interface UdpSocket {
  on(ev: "message", h: (bytes: Uint8Array, from: { address: string; port: number }) => void): UdpSocket;
  send(bytes: ArrayLike<number> | ArrayBuffer, port: number, address: string): Promise<void>;
  close(): void;
}
export interface Nanite {
  rootMounted: boolean;
  /** Nanite's worker: the page also hears the Wisp state from it ({ ev: "wisp", state }, see WISP_RECONNECT). */
  worker: { addEventListener(type: "message", f: (e: MessageEvent) => void): void };
  network: {
    bindUDP(port: number): UdpSocket;
    fetch(port: number, path: string, init?: { method?: string; headers?: HeadersInit; body?: string | Uint8Array | null }, opts?: { timeout?: number }): Promise<Response>;
  };
  resize(cols: number, rows: number, termId?: number): void;
  /** The display's size changed (newer Nanite): the guest's DRM connector offers width x height as its preferred mode, with a
   *  hotplug event; the picture takes the size the guest sets. /dev/fb0 keeps its size. */
  resizeScreen?(width: number, height: number, devicePixelRatio?: number): void;
  stdin(bytes: Uint8Array, termId?: number): void;
  openTerminal(argv: string[], env?: string[], size?: { cols?: number; rows?: number }): Promise<number>;
  closeTerminal(termId: number): void;
  run(argv: string[], env?: string[]): Promise<{ code: number }>;
  flush(): Promise<void>;
  loadTar(bytes: Uint8Array): Promise<number>;
  loadTarStream(stream: ReadableStream<Uint8Array>): Promise<number>;
  key(code: number, down: boolean): void;
  mouse(m: { dx?: number; dy?: number; button?: number; down?: boolean }): void;
  terminate(): void;
}
/** Nanite's "memoryevent": memory ran out (the machine's cap, a process's cap, or the browser refused), and what the OOM killer ended. */
export interface MemoryEvent {
  kind: "limit" | "process" | "host";
  op: string; pid: number; name?: string;
  requested: number; inUse: number; limit: number | null;
  killed: { pid: number; name?: string; resident: number; oomScoreAdj: number }[];
  /** freed: the request got its memory (after kills); denied: it failed; over: the machine is over its cap (no OOM killer). */
  result: "freed" | "denied" | "over";
}
export interface Hooks {
  onMemoryEvent(e: MemoryEvent): void;
  onOutput(fd: number, bytes: Uint8Array, termId?: number): void;
  onFrame(w: number, h: number, pixels: Uint8ClampedArray): void;
  onTerminalExit(termId: number, code: number): void;
}
type NaniteModule = { Nanite: { create(o: Record<string, unknown>): Promise<Nanite> }; embeddedWorkerUrl(): string };

const MiB = 2 ** 20;
const enc = new TextEncoder();
// The whole root filesystem is on disk: Nanite's disk-backed root (OPFS directory nanite-root-<disk>, one per root in
// lib/roots.ts), only its metadata in the kernel's memory. A root's first start unpacks its image into it; later starts mount it.
const diskDir = (disk: string) => `nanite-root-${disk}`;

// A login shell's environment, as login(1) + the shell would set it for root.
const baseEnv = (shell: string) => [
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "HOME=/root", "USER=root", "LOGNAME=root", `SHELL=${shell}`, "MAIL=/var/mail/root",
  "TERM=xterm-256color", "COLORTERM=truecolor", "LANG=C.UTF-8", "LC_ALL=C.UTF-8",
  "PAGER=less", "LESS=-R",
];
export interface Shells {
  /** fish (the demo root), bash (most), or sh (Alpine, many Docker images). */
  kind: "fish" | "bash" | "sh";
  /** The console's login shell (the main tab), started in $HOME. */
  console: string[]; env: string[];
  /** A further terminal (Nanite's openTerminal) in `cwd`, and its environment. */
  term: (cwd?: string) => string[]; termEnv: (cwd?: string) => string[];
}
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** The shells for a root, by its login shell.
 *  The shell is the session leader itself, never cd-and-exec, in terminals: when a terminal's session leader execs, Nanite loses
 *  its output. fish goes to the folder with --init-command; bash from PROMPT_COMMAND, before its first
 *  prompt; sh starts in /. Login shells with --login, not exec -l: Nanite does not keep the "-" that exec -l puts in front of
 *  argv[0]. The console (Nanite's run) may exec. MOTD_SHOWN is set in further terminals (the motd scripts show it at every login unless ~/.hidemotd exists). */
export function shells(kind: Shells["kind"]): Shells {
  if (kind === "fish") {
    // fish_use_posix_spawn=0: fish starts programs with fork, not posix_spawn (whose vfork-style clone loses fish on Nanite:
    // it died at pipelines and at its first command).
    const env = [...baseEnv("/usr/bin/fish"), "fish_use_posix_spawn=0"];
    const term = (cwd = "~") => ["/usr/bin/fish", "--login", "--init-command", `cd ${cwd === "~" ? "~" : q(cwd)}`];
    return { kind, console: term(), env, term, termEnv: () => [...env, "MOTD_SHOWN=1"] };
  }
  if (kind === "bash") {
    const env = baseEnv("/bin/bash");
    return {
      kind, console: ["/bin/bash", "-c", 'cd "$HOME" && exec /bin/bash --login'], env,
      term: () => ["/bin/bash", "--login"],
      termEnv: (cwd = "~") => [...env, "MOTD_SHOWN=1", `PROMPT_COMMAND=cd ${cwd === "~" ? "~" : q(cwd)}; unset PROMPT_COMMAND`],
    };
  }
  const env = baseEnv("/bin/sh");
  return { kind, console: ["/bin/sh", "-c", 'cd "$HOME"; exec /bin/sh -l'], env, term: () => ["/bin/sh", "-l"], termEnv: () => [...env, "MOTD_SHOWN=1"] };
}

// Wisp: "server" mode, the Wisp server in the settings (or ?wisp=); "router" mode, the nearest relay a Wispr router names (lib/wisp.ts:
// Spark's /closest router by default, else the time zone).
export async function nearestWisp(l: Pick<Launch, "wispMode" | "wisp" | "wispRouter">): Promise<{ url: string; name: string }> {
  if (l.wispMode === "server" && l.wisp) return { url: l.wisp, name: new URL(l.wisp).host };
  const { pick } = await locate(l.wispRouter);
  return { url: pick.url, name: pick.name };
}

// Wisp that reconnects. Nanite's Wisp client (in its worker) opens one WebSocket and, when it drops, fails the open connections
// and never opens another: the machine would stay offline. Nanite starts its worker from `workerUrl` (a module), so the page
// starts Nanite's own worker (embeddedWorkerUrl) behind this module, which runs first and gives the worker a WebSocket that
// reconnects (0.5 s, 1 s, 2 s ... 15 s, and at once when the browser is back online). To Nanite each drop is a close (the
// connections then open fail with ECONNREFUSED, as they would), and each reconnect an open (it sends what it queued meanwhile).
// The worker tells the page { ev: "wisp", state: "down" | "up" }; Nanite ignores events it does not know.
const WISP_RECONNECT = `
const Real = globalThis.WebSocket;
const tell = (state) => { try { self.postMessage({ ev: "wisp", state }); } catch {} };
class ReconnectingWebSocket {
  constructor(url, protocols) {
    this.url = url; this.protocols = protocols; this.type = "blob"; this.tries = 0; this.ws = null; this.ended = false; this.wasUp = false;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    self.addEventListener("online", () => { if (!this.ws && !this.ended) { clearTimeout(this.timer); this.connect(); } });
    this.connect();
  }
  get binaryType() { return this.type; }
  set binaryType(t) { this.type = t; if (this.ws) this.ws.binaryType = t; }
  get readyState() { return this.ws ? this.ws.readyState : 0; }
  get protocol() { return this.ws ? this.ws.protocol : ""; }
  connect() {
    const ws = this.ws = new Real(this.url, this.protocols);
    ws.binaryType = this.type;
    ws.onopen = (e) => { this.tries = 0; if (this.wasUp) tell("up"); this.wasUp = true; this.onopen?.(e); };
    ws.onmessage = (e) => this.onmessage?.(e);
    ws.onerror = () => {};
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onclose?.(e);
      if (this.ended) return;
      tell("down");
      this.timer = setTimeout(() => this.connect(), Math.min(15000, 500 * 2 ** this.tries++));
    };
  }
  send(d) { if (this.ws && this.ws.readyState === 1) this.ws.send(d); }
  close() { this.ended = true; clearTimeout(this.timer); this.ws?.close(); }
}
ReconnectingWebSocket.CONNECTING = 0; ReconnectingWebSocket.OPEN = 1; ReconnectingWebSocket.CLOSING = 2; ReconnectingWebSocket.CLOSED = 3;
globalThis.WebSocket = ReconnectingWebSocket;

// Memory accounting: every WebAssembly memory and module Nanite makes in this worker, for { op: "mem" } (machine.ts memReport).
const W = WebAssembly, mems = new Set(), mods = [];
const RealMemory = W.Memory;
W.Memory = function (d) { const m = new RealMemory(d); mems.add(new WeakRef(m)); return m; };
W.Memory.prototype = RealMemory.prototype;
const size = (b) => b?.byteLength ?? b?.buffer?.byteLength ?? 0;
const RealModule = W.Module, RealCompile = W.compile, RealInst = W.instantiate, RealStream = W.compileStreaming, RealInstStream = W.instantiateStreaming;
W.Module = function (b, o) { mods.push(size(b)); return new RealModule(b, o); }; W.Module.prototype = RealModule.prototype;
Object.assign(W.Module, { imports: RealModule.imports, exports: RealModule.exports, customSections: RealModule.customSections });
W.compile = (b, o) => { mods.push(size(b)); return RealCompile(b, o); };
const exported = (inst) => { for (const v of Object.values(inst.exports)) if (v instanceof RealMemory) mems.add(new WeakRef(v)); return inst; };
W.instantiate = (b, i, o) => { if (!(b instanceof RealModule)) mods.push(size(b));
  return RealInst(b, i, o).then((r) => { exported(r.instance ?? r); return r; }); };
const RealInstance = W.Instance;
W.Instance = function (m, i) { return exported(new RealInstance(m, i)); }; W.Instance.prototype = RealInstance.prototype;
self.addEventListener("message", (e) => {
  if (e.data?.op !== "mem") return;
  e.stopImmediatePropagation();
  const live = [...mems].map((r) => r.deref()).filter(Boolean).map((m) => m.buffer.byteLength).sort((a, b) => b - a);
  self.postMessage({ ev: "mem", memories: live, modules: mods.length, moduleBytes: mods.reduce((a, b) => a + b, 0) });
});
`;
const blobUrl = (code: string) => URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
let workerUrl: string | null = null;
/** Nanite's worker, behind the reconnecting WebSocket (imports run in order: the WebSocket first, then Nanite's worker). */
function naniteWorker(mod: NaniteModule): string {
  return (workerUrl ??= blobUrl(`import ${JSON.stringify(blobUrl(WISP_RECONNECT))};\nimport ${JSON.stringify(mod.embeddedWorkerUrl())};\n`));
}

/** What Nanite's worker holds: its WebAssembly memories (bytes each, largest first) and the modules it compiled. */
export function memReport(nv: Nanite): Promise<{ memories: number[]; modules: number; moduleBytes: number }> {
  return new Promise((resolve) => {
    const w = nv.worker as unknown as Worker;
    const on = (e: MessageEvent) => { if (e.data?.ev === "mem") { w.removeEventListener("message", on); resolve(e.data); } };
    w.addEventListener("message", on); w.postMessage({ op: "mem" });
  });
}

export const loadNanite = (pkg: string): Promise<NaniteModule> => import(/* @vite-ignore */ `${pkg}/lib/nanitevisor/nanite.js`);

export function createMachine(mod: NaniteModule, l: Launch, wisp: string, screen: { width: number; height: number }, disk: string, hooks: Hooks): Promise<Nanite> {
  const lib = `${l.pkg}/lib/nanitevisor`;
  return mod.Nanite.create({
    workerUrl: naniteWorker(mod),
    naniteUrl: `${lib}/nanite.wasm`, vkernelUrl: `${lib}/vkernel.wasm`, tty: true, wisp,
    devices: { fb: screen, sound: false, gpu: false },
    memoryLimit: l.memory * MiB, processMemoryLimit: (l.processMemory ?? Math.min(l.memory, 256)) * MiB,
    ...(l.dcache != null ? { dcacheBytes: l.dcache * MiB } : {}),
    cacheBytes: (l.diskCache ?? 16) * MiB,   // Nanite's default is 64 MiB of the page's memory, outside the machine's memory cap
    oomKiller: l.oomKiller ?? true, singleMemory: l.memoryMode === "single",
    ...(l.memoryMode === "single" && l.slotSize ? { slotSize: l.slotSize * MiB } : {}),
    cacheBackend: l.cacheBackend ?? "disk", rootStorage: l.rootStorage ?? "disk", prewarm: l.prewarm ?? true, jspi: l.jspi ?? true,
    rootName: disk, ...hooks,
  });
}

// ustar: a header for a regular file, and one small text file as a whole archive (for loadTar()).
export function tarHeader(name: string, size: number): Uint8Array {
  const h = new Uint8Array(512), put = (o: number, v: string) => h.set(enc.encode(v), o);
  put(0, name); put(100, "0000644\0"); put(108, "0000000\0"); put(116, "0000000\0");
  put(124, size.toString(8).padStart(11, "0") + "\0");
  put(136, Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0");
  h.fill(32, 148, 156); h[156] = 48; put(257, "ustar\0"); put(263, "00");
  put(148, h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ");
  return h;
}
const tarPad = (n: number) => new Uint8Array((512 - (n % 512)) % 512);
export function tarFile(name: string, text: string): Uint8Array {
  const body = enc.encode(text), out = new Uint8Array(512 + body.length + tarPad(body.length).length);
  out.set(tarHeader(name, body.length)); out.set(body, 512); return out;
}

// ICMP ping. Nanite's network carries only TCP and UDP, so the guest's ping (/usr/local/bin/ping, source in
// demo/rootfs/usr/local/src/ping) sends each echo request as a UDP datagram to this bridge at the gateway, 10.0.2.2:7007. The
// bridge sends it as a real ICMP echo through Spark's Wisp ping extension (0xE1 on a "wisp-v2" connection,
// https://wisp.sparkpowered.org/#icmp): one ping stream per guest socket and target, each DATA one echo, each reply a DATA back.
//   guest -> bridge  "NPNG" | host length | IPv4 address as text | payload      bridge -> guest  "NPNG" | 0 | reply payload, or 1 | error
const PING_PORT = 7007, NPNG = [78, 80, 78, 71];
const WISP_CLOSE: Record<number, string> = { 0x41: "the Wisp server refused the ping extension", 0x42: "Destination Host Unreachable", 0x47: "timed out",
  0x48: "refused: private or local address", 0x49: "throttled by the Wisp server" };
type PingStream = { key: string; id: number; to: { address: string; port: number }; last: number };
export function pingBridge(nv: Nanite, wispUrl: string): () => void {
  const sock = nv.network.bindUDP(PING_PORT), dec = new TextDecoder();
  const streams = new Map<string, PingStream>(), byId = new Map<number, PingStream>();   // "address:port|host" -> stream, and stream id -> stream
  let ws: WebSocket | null = null, ready: Promise<WebSocket> | null = null, nextId = 1;
  const packet = (type: number, id: number, payload: ArrayLike<number>) => { const b = new Uint8Array(5 + payload.length); b[0] = type; new DataView(b.buffer).setUint32(1, id, true); b.set(payload, 5); return b; };
  const answer = (to: PingStream["to"], kind: number, bytes: Uint8Array) => { const b = new Uint8Array(5 + bytes.length); b.set(NPNG); b[4] = kind; b.set(bytes, 5); void sock.send(b, to.port, to.address); };
  const drop = (s: PingStream) => { streams.delete(s.key); byId.delete(s.id); };
  const offers = (info: Uint8Array, ext: number) => {   // INFO: version (2 bytes), then extensions: id, payload length (u32 LE), payload
    const dv = new DataView(info.buffer, info.byteOffset);
    for (let p = 7; p + 5 <= info.length; p += 5 + dv.getUint32(p + 1, true)) if (info[p] === ext) return true;
    return false;
  };
  const connect = () => ready ??= new Promise<WebSocket>((resolve, reject) => {
    const w = new WebSocket(wispUrl, "wisp-v2"); w.binaryType = "arraybuffer";
    const fail = (msg: string) => { clearTimeout(t); ready = null; ws = null; reject(new Error(msg)); };
    const t = setTimeout(() => { w.close(); fail("the Wisp server did not answer"); }, 8000);
    w.onmessage = (e) => {
      const b = new Uint8Array(e.data as ArrayBuffer), id = new DataView(b.buffer).getUint32(1, true);
      if (b[0] === 5) {
        if (!offers(b, 0xe1)) { w.close(); fail("this Wisp server has no ping extension"); return; }
        w.send(packet(5, 0, [2, 0, 0xe1, 0, 0, 0, 0])); clearTimeout(t); ws = w; resolve(w);
      } else if (b[0] === 2) { const s = byId.get(id); if (s) { s.last = Date.now(); answer(s.to, 0, b.subarray(5)); } }
      else if (b[0] === 4) { const s = byId.get(id); if (s) { drop(s); answer(s.to, 1, enc.encode(WISP_CLOSE[b[5]!] ?? `closed by the Wisp server (0x${b[5]!.toString(16)})`)); } }
    };
    w.onclose = () => { for (const s of [...byId.values()]) drop(s); if (ws === w) { ws = null; ready = null; } fail("the Wisp connection closed"); };
  });
  sock.on("message", async (bytes, from) => {
    if (bytes.length < 6 || NPNG.some((c, i) => bytes[i] !== c)) return;
    const host = dec.decode(bytes.subarray(5, 5 + bytes[4]!)), payload = bytes.slice(5 + bytes[4]!);
    if (payload.length > 1200) { answer(from, 1, enc.encode("payload over 1200 bytes")); return; }
    try {
      const w = await connect(), key = `${from.address}:${from.port}|${host}`;
      let s = streams.get(key);
      if (!s) {
        s = { key, id: nextId++, to: from, last: Date.now() }; streams.set(key, s); byId.set(s.id, s);
        w.send(packet(1, s.id, [3, 0, 0, ...enc.encode(host)]));   // CONNECT: stream type 0x03 (ping), port 0, host
      }
      s.last = Date.now(); w.send(packet(2, s.id, payload));
    } catch (e) { answer(from, 1, enc.encode((e as Error).message)); }
  });
  // Close ping streams nobody has used for 15 s.
  const timer = setInterval(() => { for (const s of [...byId.values()]) if (Date.now() - s.last > 15000) { ws?.send(packet(4, s.id, [2])); drop(s); } }, 5000);
  return () => { clearInterval(timer); ws?.close(); };
}

// Save / load / reset. Nanite keeps the disk as one flat OPFS folder of files (o0, o1, ... and a manifest). The machine must be
// stopped first (so Nanite lets go of the files); afterwards the page reloads, which mounts the disk as it now is.
const SAVE_MAGIC = "nanite-webshell-disk";
export const mb = (n: number) => (n / 1e6).toFixed(1);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The worker's file handles close shortly after it is terminated: retry until they have.
async function retry<T>(f: () => Promise<T>): Promise<T> { for (let i = 0; ; i++) { try { return await f(); } catch (e) { if (i >= 50) throw e; await sleep(100); } } }
const opfsRoot = () => navigator.storage.getDirectory();

/** Packs the (stopped) machine's disk into a .tar.gz. */
export async function packDisk(disk: string, progress: (done: number, total: number) => void): Promise<Blob> {
  const dir = await (await opfsRoot()).getDirectoryHandle(diskDir(disk));
  const files: [string, File][] = [];
  for await (const [name, h] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>))
    if (h.kind === "file") files.push([name, await retry(() => (h as FileSystemFileHandle).getFile())]);
  const total = files.reduce((a, [, f]) => a + f.size, 0);
  let done = 0, shown = 0;
  async function* chunks(): AsyncGenerator<Uint8Array> {
    yield tarFile(SAVE_MAGIC, `${disk}\n`);
    for (const [name, f] of files) {
      yield tarHeader(name, f.size);
      const r = f.stream().getReader();
      for (;;) {
        const { done: end, value } = await r.read(); if (end) break;
        done += value.length; yield value;
        if (done - shown > 20e6) { shown = done; progress(done, total); }
      }
      yield tarPad(f.size);
    }
    yield new Uint8Array(1024);
  }
  const it = chunks();
  const tar = new ReadableStream<BufferSource>({ async pull(c) { const { done: end, value } = await it.next(); if (end) c.close(); else c.enqueue(value as Uint8Array<ArrayBuffer>); } });
  return new Response(tar.pipeThrough(new CompressionStream("gzip"))).blob();
}

// Reads exactly n bytes from a stream (fewer only at its end; null when nothing is left).
function byteReader(stream: ReadableStream<Uint8Array>) {
  const r = stream.getReader(); let buf: Uint8Array = new Uint8Array(0), off = 0;
  return async (n: number): Promise<Uint8Array | null> => {
    const out = new Uint8Array(n); let got = 0;
    while (got < n) {
      if (off >= buf.length) { const { done, value } = await r.read(); if (done) return got ? out.subarray(0, got) : null; buf = value; off = 0; }
      const k = Math.min(n - got, buf.length - off); out.set(buf.subarray(off, off + k), got); got += k; off += k;
    }
    return out;
  };
}
const field = (h: Uint8Array, o: number, n: number) => new TextDecoder().decode(h.subarray(o, o + n)).replace(/\0.*$/s, "");

/** Checks that a file is a save of this disk; returns the function that writes it onto the disk (with the machine stopped). */
export async function openSave(file: File, disk: string): Promise<(progress: (files: number, bytes: number) => void) => Promise<{ files: number; bytes: number }>> {
  const read = byteReader(file.stream().pipeThrough(new DecompressionStream("gzip")) as ReadableStream<Uint8Array>);
  const first = await read(512);
  if (!first || field(first, 0, 100) !== SAVE_MAGIC) throw new Error(`${file.name} is not a Nanite Webshell save`);
  const body = (await read(512)) ?? new Uint8Array(0);
  if (field(body, 0, 512).trim() !== disk) throw new Error(`${file.name} is a save of the disk ${field(body, 0, 512).trim()}, not of ${disk}: switch to that root first`);
  return async (progress) => {
    const root = await opfsRoot();
    await retry(() => root.removeEntry(diskDir(disk), { recursive: true }).catch((e) => { if (e.name !== "NotFoundError") throw e; }));
    const dir = await root.getDirectoryHandle(diskDir(disk), { create: true });
    let n = 0, bytes = 0;
    for (;;) {
      const h = await read(512);
      if (!h || h.every((b) => b === 0)) break;
      const name = field(h, 0, 100), size = parseInt(field(h, 124, 12).trim() || "0", 8), type = String.fromCharCode(h[156] || 48);
      if (type !== "0" || !/^[\w.-]+$/.test(name)) throw new Error(`unexpected entry in the save: ${name}`);
      const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
      for (let left = size; left > 0;) { const part = await read(Math.min(left, 1 << 20)); if (!part) throw new Error("the save is cut short"); await w.write(part as Uint8Array<ArrayBuffer>); left -= part.length; }
      await w.close();
      if (size % 512) await read(512 - (size % 512));
      n++; bytes += size;
      if (n % 200 === 0) progress(n, bytes);
    }
    return { files: n, bytes };
  };
}

/** Marks the disk as open in this tab (a shared Web Lock, one per tab) while its machine runs: another tab of the webshell on the
 *  same disk is then known (two machines on one disk can overwrite each other's changes, and a reset cannot delete files the other
 *  tab has open). Resolves with whether no other tab had it open, and the function that lets it go. */
const diskLock = (disk: string) => `nanite-webshell:disk:${disk}`;
export async function holdDisk(disk: string): Promise<{ held: boolean; release: () => void }> {
  if (!navigator.locks) return { held: true, release: () => {} };
  const alone = !(await diskInUse(disk));
  let release = () => {};
  await new Promise<void>((got) => {
    void navigator.locks.request(diskLock(disk), { mode: "shared" }, () => { got(); return new Promise<void>((r) => { release = r; }); });
  });
  return { held: alone, release: () => release() };
}
/** Whether a tab has the disk open (holdDisk); this tab's own hold counts too, so let it go first. */
export async function diskInUse(disk: string): Promise<boolean> {
  const q = await navigator.locks?.query?.();
  return !!q?.held?.some((l) => l.name === diskLock(disk));
}
/** A reset whose delete failed (a file of the disk still open as the page went): done at the next start, before Nanite opens it. */
const PENDING_RESET = "nanite-webshell:reset-pending";
export const markReset = (disk: string) => { try { localStorage.setItem(PENDING_RESET, disk); } catch {} };
export function takeReset(disk: string): boolean {
  try { if (localStorage.getItem(PENDING_RESET) !== disk) return false; localStorage.removeItem(PENDING_RESET); return true; } catch { return false; }
}

/** Deletes the disk (the machine stopped); the next start unpacks a fresh Ubuntu. */
export async function deleteDisk(disk: string): Promise<void> {
  const root = await opfsRoot();
  await retry(() => root.removeEntry(diskDir(disk), { recursive: true }).catch((e) => { if (e.name !== "NotFoundError") throw e; }));
}
