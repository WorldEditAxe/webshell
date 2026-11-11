// Tunnels: the machine's TCP ports reachable from the internet. The page is the client (nothing runs in the machine): it dials
// the tunnel service through the machine's Wisp relay (lib/wisp.ts) and joins each incoming connection to the guest's port with
// Nanite's network.connectTCP.
//   bore      bore's protocol (https://github.com/ekzhang/bore), on bore.pub (public, no account) or on a bore server of your own
//             (`bore server`, with or without --secret). Control connection to the server's port 7835, messages JSON + NUL:
//             {"Hello":0} -> {"Hello":PORT} (the public port), then "Heartbeat"s; for each visitor {"Connection":"<uuid>"}: a new
//             connection sends {"Accept":"<uuid>"} and then carries that visitor's bytes. With a secret, every connection first
//             gets {"Challenge":"<uuid>"} and answers {"Authenticate":hex(HMAC-SHA256(key = SHA-256(secret), the uuid's 16 bytes))}.
// PROXY protocol (HAProxy, v1 or v2): each connection to the guest can start with a PROXY header, for servers that take it
// (nginx `listen ... proxy_protocol`, HAProxy `accept-proxy`). bore does not tell who the visitor is: its header is
// "PROXY UNKNOWN" (v1) or a LOCAL one (v2); a service that knows the visitor gives the addresses.
// The list is kept (localStorage) and the tunnels start again with the machine.
import { WispConn, type WispStream } from "./wisp";
import type { Nanite } from "./machine";

const KEY = "nanite-webshell:tunnels";
export const BORE_PUB = "bore.pub";
const BORE_PORT = 7835;
const enc = new TextEncoder(), dec = new TextDecoder();

export type Provider = "bore.pub" | "bore";
export type ProxyProtocol = "off" | "v1" | "v2";
export type TunnelSpec = { provider: Provider; port: number; proxy: ProxyProtocol; server?: string; secret?: string };
type Saved = TunnelSpec & { id: string; remotePort?: number };
type TcpConn = { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; close(): void };
export type Net = { connectTCP(port: number, o?: { timeout?: number; guestAddress?: string }): Promise<TcpConn> };
export type Addr = { address: string; port: number };

export class Tunnel {
  id: string; provider: Provider; port: number; proxy: ProxyProtocol; server?: string; secret?: string;
  /** The public address once the service gave one (host:port). */
  address = $state("");
  status = $state<"starting" | "up" | "retrying" | "stopped">("starting");
  error = $state("");
  /** Visitors connected now, and since the start. */
  open = $state(0);
  total = $state(0);
  remotePort?: number;
  stopFn: (() => void) | null = null;
  constructor(s: Saved) {
    this.id = s.id; this.provider = s.provider; this.port = s.port; this.proxy = s.proxy ?? "off";
    this.server = s.server; this.secret = s.secret; this.remotePort = s.remotePort;
  }
  /** The service's host and control port. */
  get host(): { host: string; port: number } {
    if (this.provider === "bore.pub" || !this.server) return { host: BORE_PUB, port: BORE_PORT };
    const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(this.server.trim());
    return { host: m?.[1] ?? this.server, port: m?.[2] ? +m[2] : BORE_PORT };
  }
  get label(): string { return this.provider === "bore.pub" ? "bore.pub" : this.host.host; }
}

export class Tunnels {
  list = $state<Tunnel[]>([]);
  private conn: Promise<WispConn> | null = null;
  /** The machine (its network), for other tunnel clients (lib/playit.svelte.ts). */
  get net(): Net | null { return (this.nv()?.network as unknown as Net | undefined) ?? null; }
  constructor(private nv: () => Nanite | null, private relay: () => string | null) {
    for (const s of load()) this.list.push(new Tunnel(s));
  }

  /** The page's own Wisp connection for tunnels (one, shared; opened again when it drops). */
  wisp(): Promise<WispConn> {
    const url = this.relay();
    if (!url) return Promise.reject(new Error("the machine has no Wisp relay yet"));
    return (this.conn ??= WispConn.open(url).then((c) => { c.onclose = () => { this.conn = null; }; return c; }, (e) => { this.conn = null; throw e; }));
  }

  add(spec: TunnelSpec): void {
    const t = new Tunnel({ ...spec, id: Math.random().toString(36).slice(2, 9) });
    this.list.push(t); this.save(); void this.start(this.list[this.list.length - 1]!);
  }
  remove(t: Tunnel): void { this.stop(t); this.list = this.list.filter((x) => x.id !== t.id); this.save(); }
  /** Changes a tunnel's PROXY protocol (new connections get it). */
  setProxy(t: Tunnel, p: ProxyProtocol): void { t.proxy = p; this.save(); }
  /** Starts every tunnel (when the machine is up). */
  startAll(): void { for (const t of this.list) if (t.status === "starting" || t.status === "stopped") void this.start(t); }
  stop(t: Tunnel): void { t.stopFn?.(); t.stopFn = null; t.status = "stopped"; }
  private save(): void {
    const out: Saved[] = this.list.map((t) => ({ id: t.id, provider: t.provider, port: t.port, proxy: t.proxy, server: t.server, secret: t.secret, remotePort: t.remotePort }));
    try { localStorage.setItem(KEY, JSON.stringify(out)); } catch {}
  }

  async start(t: Tunnel): Promise<void> {
    t.stopFn?.(); t.error = ""; t.status = "starting";
    let stopped = false, retry = 0 as unknown as ReturnType<typeof setTimeout>, ctl: WispStream | null = null;
    const visitors = new Set<() => void>();
    t.stopFn = () => { stopped = true; clearTimeout(retry); ctl?.close(); for (const v of visitors) v(); visitors.clear(); t.open = 0; };
    const again = (why: string) => {
      ctl = null;
      if (stopped) return;
      t.status = "retrying"; t.error = why;
      retry = setTimeout(() => { if (!stopped) void this.start(t); }, 5000);
    };
    try {
      const w = await this.wisp();
      if (stopped) return;
      const { host, port } = t.host;
      const c = w.open("tcp", host, port);
      ctl = c;
      // Ask for the same public port as last time; the server gives another if it is taken.
      const hello = () => send(c, { Hello: t.remotePort ?? 0 });
      c.ondata = framer(async (m) => {
        if (m === "Heartbeat") return;
        const o = (typeof m === "object" && m ? m : {}) as Record<string, unknown>;
        if ("Challenge" in o) {
          if (!t.secret) { t.error = `${t.label} wants a secret`; c.close(); return; }
          send(c, { Authenticate: await answer(t.secret, String(o.Challenge)) }); hello();
        } else if ("Hello" in o) {
          t.remotePort = Number(o.Hello); t.address = `${host}:${t.remotePort}`; t.status = "up"; t.error = ""; this.save();
        } else if ("Connection" in o) void this.visitor(t, w, String(o.Connection), visitors);
        else if ("Error" in o) t.error = String(o.Error);
      });
      c.onclose = (why) => again(`${t.label}: ${why}`);
      if (!t.secret) hello();   // with a secret, the server speaks first (Challenge)
    } catch (e) { again((e as Error).message); }
  }

  /** One visitor: a connection to the bore server that accepts it, joined to the guest's port. */
  private async visitor(t: Tunnel, w: WispConn, uuid: string, visitors: Set<() => void>): Promise<void> {
    const { host, port } = t.host, remote = w.open("tcp", host, port), early: Uint8Array[] = [];
    let gone = false;
    remote.onclose = () => { gone = true; };
    if (t.secret) {
      // The server's Challenge first; after our Accept, the stream is the visitor's bytes.
      let buf = new Uint8Array(0);
      remote.ondata = async (b) => {
        const all = new Uint8Array(buf.length + b.length); all.set(buf); all.set(b, buf.length); buf = all;
        const nul = buf.indexOf(0);
        if (nul < 0) return;
        remote.ondata = (x) => early.push(x);
        if (buf.length > nul + 1) early.push(buf.slice(nul + 1));
        let ch = "";
        try { ch = String((JSON.parse(dec.decode(buf.subarray(0, nul))) as { Challenge?: string }).Challenge ?? ""); } catch {}
        if (!ch) { remote.close(); return; }
        send(remote, { Authenticate: await answer(t.secret!, ch) }); send(remote, { Accept: uuid });
      };
    } else {
      remote.ondata = (b) => early.push(b);      // what the visitor sends before the guest's port answered
      send(remote, { Accept: uuid });
    }
    await this.join(t, remote, early, () => gone, visitors, null);
  }

  private async join(t: Tunnel, remote: WispStream, early: Uint8Array[], gone: () => boolean, visitors: Set<() => void>, peer: { src: Addr; dst: Addr } | null): Promise<void> {
    const net = this.nv()?.network as unknown as Net | undefined;
    if (!net) { remote.close(); return; }
    await joinGuest({ net, port: t.port, header: t.proxy !== "off" ? proxyHeader(t.proxy, peer) : null, remote, early, gone, visitors, counters: t,
      onError: (m) => { t.error = m; } });
  }
}

/** Joins a visitor's stream (`remote`, with what it sent so far in `early`) to the guest's TCP port, the PROXY `header` first,
 *  until either side ends. `counters` counts the open and total connections. */
export async function joinGuest(o: {
  net: Net; port: number; guestAddress?: string; header: Uint8Array | null; remote: WispStream; early: Uint8Array[]; gone: () => boolean;
  visitors: Set<() => void>; counters: { open: number; total: number }; onError: (msg: string) => void;
}): Promise<void> {
  const { remote, counters } = o;
  let guest: TcpConn;
  try { guest = await o.net.connectTCP(o.port, { timeout: 5000, ...(o.guestAddress ? { guestAddress: o.guestAddress } : {}) }); }
  catch (e) { o.onError(`port ${o.port} in the machine: ${(e as Error).message}`); remote.close(); return; }
  if (o.gone()) { guest.close(); return; }
  counters.open++; counters.total++;
  let done = false;
  const writer = guest.writable.getWriter();
  const end = () => {
    if (done) return; done = true; o.visitors.delete(end); counters.open = Math.max(0, counters.open - 1);
    remote.close(); try { void writer.close().catch(() => {}); guest.close(); } catch {}
  };
  o.visitors.add(end);
  if (o.header) void writer.write(o.header).catch(end);
  for (const b of o.early) void writer.write(b).catch(end);
  remote.ondata = (b) => { void writer.write(b).catch(end); };
  remote.onclose = end;
  void (async () => {
    const reader = guest.readable.getReader();
    try { for (;;) { const { value, done: eof } = await reader.read(); if (eof) break; if (value?.length) remote.send(value); } }
    catch {} finally { end(); }
  })();
}

const send = (s: WispStream, m: unknown) => s.send(enc.encode(JSON.stringify(m) + "\0"));

/** bore's answer to a challenge: hex HMAC-SHA256 of the uuid's 16 bytes, keyed with SHA-256 of the secret. */
async function answer(secret: string, uuid: string): Promise<string> {
  const keyBytes = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const hex = uuid.replace(/-/g, ""), bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A PROXY protocol header (https://www.haproxy.org/download/2.9/doc/proxy-protocol.txt): v1 text or v2 binary. Without the
 *  visitor's addresses: v1 "PROXY UNKNOWN", v2 a LOCAL header (the receiver keeps the connection's own addresses). */
export function proxyHeader(v: "v1" | "v2", peer: { src: Addr; dst: Addr } | null, udp = false): Uint8Array {
  const six = peer ? peer.src.address.includes(":") : false;
  if (v === "v1") {
    if (!peer) return enc.encode("PROXY UNKNOWN\r\n");
    return enc.encode(`PROXY ${six ? "TCP6" : "TCP4"} ${peer.src.address} ${peer.dst.address} ${peer.src.port} ${peer.dst.port}\r\n`);
  }
  const sig = [0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a];
  if (!peer) return new Uint8Array([...sig, 0x20, 0x00, 0, 0]);          // LOCAL, AF_UNSPEC, no addresses
  const ip = six ? (a: string) => ipv6(a) : (a: string) => a.split(".").map(Number);
  const body = [...ip(peer.src.address), ...ip(peer.dst.address), peer.src.port >> 8, peer.src.port & 255, peer.dst.port >> 8, peer.dst.port & 255];
  return new Uint8Array([...sig, 0x21, (six ? 0x20 : 0x10) | (udp ? 0x02 : 0x01), body.length >> 8, body.length & 255, ...body]);
}
function ipv6(a: string): number[] {
  const [head, tail = ""] = a.split("::"), h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  const groups = [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return groups.flatMap((g) => { const n = parseInt(g || "0", 16); return [n >> 8, n & 255]; });
}

/** Splits a byte stream into NUL-terminated JSON messages. */
function framer(on: (m: unknown) => void): (b: Uint8Array) => void {
  let buf = "";
  return (b) => {
    buf += dec.decode(b, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\0")) >= 0) {
      const one = buf.slice(0, i); buf = buf.slice(i + 1);
      try { on(JSON.parse(one)); } catch {}
    }
  };
}

function load(): Saved[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(v)) return [];
    // Saved before there were providers: { kind: "bore" } meant bore.pub.
    return v.map((x) => (x?.kind === "bore" && !x.provider ? { ...x, provider: "bore.pub", proxy: "off" } : x))
      .filter((x) => (x?.provider === "bore.pub" || x?.provider === "bore") && x.port > 0);
  } catch { return []; }
}
